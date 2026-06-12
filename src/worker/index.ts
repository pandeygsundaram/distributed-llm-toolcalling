import "dotenv/config";
import { hostname } from "os";
import { v4 as uuid } from "uuid";
import { logger } from "../logger.js";
import { config } from "../config.js";
import {
  getStreamClient,
  getPubClient,
  ensureConsumerGroup,
  publishResult,
  POD_FREED_CHANNEL,
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
    const acquired = await leaseManager.acquirePod(context);
    podName = acquired.pod;

    log.info({ pod: podName, queuePosition: acquired.queuePosition, waitMs: acquired.waitMs }, "worker.pod.acquired");

    // Annotate pod with current tool call id for kubectl observability
    await leaseManager.annotatePod(podName, job.toolCallId);

    // Execute the tool inside the pod
    const result = await podExecutor.run(podName, job.tool, job.input, config.TOOL_TIMEOUT_MS);

    const output = result.exitCode === 0
      ? result.stdout || "(empty output)"
      : `Exit ${result.exitCode}:\n${result.stderr || result.stdout}`;

    const completedPod = podName;
    const durationMs = Date.now() - start;

    // Step 1: publish result → caller gets the output immediately
    await publishResult(job.toolCallId, {
      toolCallId: job.toolCallId,
      tool: job.tool,
      output,
      status: result.exitCode === 0 ? "completed" : "failed",
      pod: completedPod,
      durationMs,
    });

    // Step 2: release the lease so the next waiter can acquire this pod
    await leaseManager.clearAnnotations(completedPod);
    await leaseManager.releasePod(completedPod);
    podName = null; // prevent double-release in finally

    // Step 3: notify this specific caller that its pod is now freed
    await getPubClient().publish(POD_FREED_CHANNEL(job.toolCallId), completedPod);

    log.info({ pod: completedPod, durationMs }, "worker.job.completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedPod = podName ?? "unassigned";
    log.error({ pod: failedPod, error: message, durationMs: Date.now() - start }, "worker.job.failed");

    await publishResult(job.toolCallId, {
      toolCallId: job.toolCallId,
      tool: job.tool,
      output: `Error: ${message}`,
      status: "failed",
      pod: failedPod,
      durationMs: Date.now() - start,
    });
  } finally {
    // Safety net: release lease if still held (e.g. error during publishResult itself)
    if (podName) {
      await leaseManager.clearAnnotations(podName).catch(() => {});
      await leaseManager.releasePod(podName).catch(() => {});
      await getPubClient().publish(POD_FREED_CHANNEL(job.toolCallId), podName).catch(() => {});
      podName = null;
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
