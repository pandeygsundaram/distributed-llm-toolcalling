import "dotenv/config";
import { hostname } from "os";
import { v4 as uuid } from "uuid";
import { logger } from "../logger.js";
import { config } from "../config.js";
import {
  getStreamClient,
  ensureConsumerGroup,
  publishResult,
  STREAM_KEY,
  CONSUMER_GROUP,
  type ToolCallJob,
} from "../queue/redis-client.js";
import { LeaseManager } from "../sandbox/lease-manager.js";
import { PodExecutor } from "../sandbox/pod-executor.js";

const INSTANCE_ID = `worker-${hostname()}-${uuid().slice(0, 8)}`;
const CONSUMER_NAME = INSTANCE_ID;

const leaseManager = new LeaseManager();
const podExecutor = new PodExecutor();

async function processJob(streamId: string, job: ToolCallJob): Promise<void> {
  const log = logger.child({
    streamId,
    toolCallId: job.toolCallId,
    tool: job.tool,
    requestId: job.requestId,
    sessionId: job.sessionId,
  });

  log.info("worker.job.received");

  const context = {
    instanceId: INSTANCE_ID,
    requestId: job.requestId,
    sessionId: job.sessionId,
    toolCallId: job.toolCallId,
  };

  const start = Date.now();
  let podName: string | null = null;

  try {
    // Acquire a pod lease (may queue if all 8 are busy)
    podName = await leaseManager.acquirePod(context);

    log.info({ pod: podName }, "worker.pod.acquired");

    // Execute the tool inside the pod
    const result = await podExecutor.run(podName, job.tool, job.input, config.TOOL_TIMEOUT_MS);

    const output = result.exitCode === 0
      ? result.stdout || "(empty output)"
      : `Exit ${result.exitCode}:\n${result.stderr || result.stdout}`;

    await publishResult(job.toolCallId, {
      toolCallId: job.toolCallId,
      tool: job.tool,
      output,
      status: result.exitCode === 0 ? "completed" : "failed",
      pod: podName,
      durationMs: Date.now() - start,
    });

    log.info({ pod: podName, durationMs: Date.now() - start }, "worker.job.completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ pod: podName, error: message, durationMs: Date.now() - start }, "worker.job.failed");

    await publishResult(job.toolCallId, {
      toolCallId: job.toolCallId,
      tool: job.tool,
      output: `Error: ${message}`,
      status: "failed",
      pod: podName ?? "unassigned",
      durationMs: Date.now() - start,
    });
  } finally {
    if (podName) {
      await leaseManager.releasePod(podName);
    }
  }
}

async function parseJob(fields: string[]): Promise<ToolCallJob> {
  const map: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    map[fields[i]] = fields[i + 1];
  }
  return {
    toolCallId: map.toolCallId,
    tool: map.tool,
    input: JSON.parse(map.input ?? "{}"),
    requestId: map.requestId,
    sessionId: map.sessionId,
  };
}

async function runWorker(): Promise<void> {
  logger.info({ instanceId: INSTANCE_ID }, "worker.started");

  await ensureConsumerGroup();

  const redis = getStreamClient();

  while (true) {
    try {
      // BLOCK 5s waiting for messages — returns null on timeout, loops again
      const response = await redis.xreadgroup(
        "GROUP", CONSUMER_GROUP, CONSUMER_NAME,
        "COUNT", "1",
        "BLOCK", "5000",
        "STREAMS", STREAM_KEY, ">"
      ) as Array<[string, Array<[string, string[]]>]> | null;

      if (!response) continue;

      for (const [_stream, messages] of response) {
        for (const [streamId, fields] of messages) {
          const job = await parseJob(fields);

          // Process and ACK in background so we can pick up the next message
          // while this one is executing (worker handles one at a time per instance;
          // scale replicas for more parallelism)
          processJob(streamId, job)
            .then(() => redis.xack(STREAM_KEY, CONSUMER_GROUP, streamId))
            .catch((err) => {
              logger.error({ streamId, err: err.message }, "worker.job.unhandled-error");
              // Still ACK to avoid infinite redelivery of a poison pill
              return redis.xack(STREAM_KEY, CONSUMER_GROUP, streamId);
            });
        }
      }
    } catch (err) {
      logger.error({ err }, "worker.loop.error — retrying in 2s");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("worker.shutdown (SIGTERM)");
  process.exit(0);
});
process.on("SIGINT", () => {
  logger.info("worker.shutdown (SIGINT)");
  process.exit(0);
});

runWorker().catch((err) => {
  logger.error({ err }, "worker fatal error");
  process.exit(1);
});
