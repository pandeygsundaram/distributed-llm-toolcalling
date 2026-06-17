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
  DLQ_KEY,
  CONSUMER_GROUP,
  type ToolCallJob,
} from "../queue/redis-client.js";
import { LeaseManager } from "../sandbox/lease-manager.js";
import { PodExecutor } from "../sandbox/pod-executor.js";

const INSTANCE_ID = `worker-${hostname()}-${uuid().slice(0, 8)}`;
const CONSUMER_NAME = INSTANCE_ID;
const HEARTBEAT_INTERVAL_MS = Math.floor((config.LEASE_TTL_SECONDS * 1000) / 3);

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
  let heartbeat: NodeJS.Timeout | null = null;

  try {
    const acquired = await leaseManager.acquirePod(context);
    podName = acquired.pod;

    log.info({ pod: podName, queuePosition: acquired.queuePosition, waitMs: acquired.waitMs }, "worker.pod.acquired");

    // Heartbeat: reset Redis TTL every LEASE_TTL/3 while job is running
    heartbeat = setInterval(() => {
      leaseManager.renewLease(podName!).catch((err) =>
        log.warn({ err }, "worker.heartbeat.failed")
      );
    }, HEARTBEAT_INTERVAL_MS);

    await leaseManager.annotatePod(podName, job.toolCallId);

    const result = await podExecutor.run(podName, job.tool, job.input, config.TOOL_TIMEOUT_MS);

    const output = result.exitCode === 0
      ? result.stdout || "(empty output)"
      : `Exit ${result.exitCode}:\n${result.stderr || result.stdout}`;

    const completedPod = podName;
    const durationMs = Date.now() - start;

    clearInterval(heartbeat);
    heartbeat = null;

    // Publish result before releasing so the caller gets output ASAP
    await publishResult(job.toolCallId, {
      toolCallId: job.toolCallId,
      tool: job.tool,
      output,
      status: result.exitCode === 0 ? "completed" : "failed",
      pod: completedPod,
      durationMs,
    });

    // Cleanup sandbox files between leases
    await podExecutor.cleanup(completedPod).catch((err) =>
      log.warn({ err, pod: completedPod }, "worker.sandbox.cleanup.failed — releasing anyway")
    );

    await leaseManager.clearAnnotations(completedPod);
    await leaseManager.releasePod(completedPod);
    podName = null;

    await getPubClient().publish(POD_FREED_CHANNEL(job.toolCallId), completedPod);

    log.info({ pod: completedPod, durationMs }, "worker.job.completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedPod = podName ?? "unassigned";
    const durationMs = Date.now() - start;

    log.error({ pod: failedPod, error: message, durationMs }, "worker.job.failed");

    // Send failure to DLQ for inspection
    await getStreamClient()
      .xadd(DLQ_KEY, "*",
        "toolCallId", job.toolCallId,
        "tool", job.tool,
        "error", message,
        "pod", failedPod,
        "failedAt", new Date().toISOString()
      )
      .catch(() => {}); // DLQ write failure is non-fatal

    await publishResult(job.toolCallId, {
      toolCallId: job.toolCallId,
      tool: job.tool,
      output: `Error: ${message}`,
      status: "failed",
      pod: failedPod,
      durationMs,
    });
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
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
  logger.info({ instanceId: INSTANCE_ID, heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS }, "worker.started");

  await ensureConsumerGroup();

  const redis = getStreamClient();

  while (true) {
    try {
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

          processJob(streamId, job)
            .then(() => redis.xack(STREAM_KEY, CONSUMER_GROUP, streamId))
            .catch((err) => {
              logger.error({ streamId, err: err.message }, "worker.job.unhandled-error");
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

process.on("SIGTERM", () => {
  logger.info("worker.shutdown (SIGTERM)");
  leaseManager.stopWatchdog();
  process.exit(0);
});
process.on("SIGINT", () => {
  logger.info("worker.shutdown (SIGINT)");
  leaseManager.stopWatchdog();
  process.exit(0);
});

runWorker().catch((err) => {
  logger.error({ err }, "worker fatal error");
  process.exit(1);
});
