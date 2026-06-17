import Redis from "ioredis";
import { config } from "../config.js";
import { logger } from "../logger.js";

export const STREAM_KEY = "tool-calls";
export const DLQ_KEY = "tool-calls:dlq";
export const CONSUMER_GROUP = "workers";
export const RESULT_CHANNEL = (toolCallId: string) => `result:${toolCallId}`;
export const POD_FREED_CHANNEL = (toolCallId: string) => `pods:freed:${toolCallId}`;
export const POD_LOCK_KEY = (podName: string) => `pod:lock:${podName}`;
export const SESSION_INFLIGHT_KEY = (sessionId: string) => `session:inflight:${sessionId}`;

function makeRedis(): Redis {
  if (config.REDIS_SENTINEL_URLS) {
    const sentinels = config.REDIS_SENTINEL_URLS.split(",").map((s) => {
      const [host, port] = s.trim().split(":");
      return { host, port: parseInt(port ?? "26379", 10) };
    });
    return new Redis({ sentinels, name: "mymaster", lazyConnect: false });
  }
  return new Redis(config.REDIS_URL, { lazyConnect: false });
}

// Two separate clients — one for blocking reads, one for pub/sub (both can't do other ops while blocked)
let _stream: Redis | null = null;
let _pubsub: Redis | null = null;
let _pub: Redis | null = null;
let _lock: Redis | null = null;

export function getStreamClient(): Redis {
  if (!_stream) {
    _stream = makeRedis();
    _stream.on("error", (e) => logger.error({ err: e.message }, "redis stream error"));
  }
  return _stream;
}

export function getPubClient(): Redis {
  if (!_pub) {
    _pub = makeRedis();
    _pub.on("error", (e) => logger.error({ err: e.message }, "redis pub error"));
  }
  return _pub;
}

// Dedicated client for pod locks and session counters (not blocked by stream reads)
export function getLockClient(): Redis {
  if (!_lock) {
    _lock = makeRedis();
    _lock.on("error", (e) => logger.error({ err: e.message }, "redis lock error"));
  }
  return _lock;
}

export function newSubClient(): Redis {
  const sub = makeRedis();
  sub.on("error", (e) => logger.error({ err: e.message }, "redis sub error"));
  return sub;
}

// Publish a tool call job to the stream
export async function publishToolCall(job: ToolCallJob): Promise<string> {
  const client = getStreamClient();
  const id = await client.xadd(
    STREAM_KEY,
    "*",
    "toolCallId", job.toolCallId,
    "tool", job.tool,
    "input", JSON.stringify(job.input),
    "requestId", job.requestId,
    "sessionId", job.sessionId,
  );
  return id!;
}

// Publish result back to waiting API caller
export async function publishResult(toolCallId: string, result: ToolCallJobResult): Promise<void> {
  const client = getPubClient();
  await client.publish(RESULT_CHANNEL(toolCallId), JSON.stringify(result));
}

// Subscribe and wait for a result with timeout
export function waitForResult(toolCallId: string, timeoutMs: number): Promise<ToolCallJobResult> {
  return new Promise((resolve, reject) => {
    const sub = newSubClient();
    const channel = RESULT_CHANNEL(toolCallId);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sub.unsubscribe(channel).finally(() => sub.disconnect());
      reject(new CapacityTimeoutError());
    }, timeoutMs);

    sub.subscribe(channel, (err) => {
      if (err) {
        clearTimeout(timer);
        settled = true;
        sub.disconnect();
        reject(err);
      }
    });

    sub.on("message", (_chan: string, raw: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.unsubscribe(channel).finally(() => sub.disconnect());
      try {
        resolve(JSON.parse(raw) as ToolCallJobResult);
      } catch {
        reject(new Error("invalid result payload from worker"));
      }
    });
  });
}

// Ensure consumer group exists (idempotent)
export async function ensureConsumerGroup(): Promise<void> {
  const client = getStreamClient();
  try {
    await client.xgroup("CREATE", STREAM_KEY, CONSUMER_GROUP, "$", "MKSTREAM");
    logger.info({ stream: STREAM_KEY, group: CONSUMER_GROUP }, "redis consumer group created");
  } catch (err: unknown) {
    const e = err as Error;
    if (!e.message.includes("BUSYGROUP")) throw err;
    // Group already exists — fine
  }
}

export interface ToolCallJob {
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  requestId: string;
  sessionId: string;
}

export interface ToolCallJobResult {
  toolCallId: string;
  tool: string;
  output: string;
  status: "completed" | "failed";
  pod: string;
  durationMs: number;
}

export class CapacityTimeoutError extends Error {
  readonly code = "sandbox_capacity_timeout";
  constructor() {
    super("No sandbox pod became available within the timeout period.");
    this.name = "CapacityTimeoutError";
  }
}

// Wait until the specific pod for this toolCallId is freed (or timeout — resolves anyway)
export function waitForPodFreed(toolCallId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sub = newSubClient();
    const channel = POD_FREED_CHANNEL(toolCallId);
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      sub.unsubscribe(channel).finally(() => sub.disconnect());
      resolve();
    };

    const timer = setTimeout(done, timeoutMs);

    sub.subscribe(channel, (err) => {
      if (err) {
        clearTimeout(timer);
        settled = true;
        sub.disconnect();
        reject(err);
      }
    });

    sub.on("message", () => {
      clearTimeout(timer);
      done();
    });
  });
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([
    _stream?.quit(),
    _pub?.quit(),
    _pubsub?.quit(),
    _lock?.quit(),
  ]);
}
