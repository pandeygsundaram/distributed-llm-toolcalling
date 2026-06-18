/**
 * Direct infra stress test — bypasses Claude entirely.
 * Publishes tool call jobs straight to Redis stream and waits for results
 * exactly like RedisExecutor does. Tests the worker → pod → HPA pipeline.
 *
 * Usage:
 *   node tests/stress/infra-stress.mjs
 *   node tests/stress/infra-stress.mjs --jobs=1000 --tool=math_compute --input='{"operation":"fibonacci","a":10000}'
 *   node tests/stress/infra-stress.mjs --jobs=500  --tool=shell_run    --input='{"command":"ls"}'
 *   node tests/stress/infra-stress.mjs --jobs=200  --tool=shell_run    --input='{"command":"sleep","args":["20"]}' --timeout=90000
 */
import Redis from "../../node_modules/ioredis/built/index.js";
import { randomUUID } from "crypto";

// ── CLI flags ──────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith("--"))
    .map(a => { const [k, ...rest] = a.slice(2).split("="); return [k, rest.join("=")]; })
);

const JOBS       = parseInt(args.jobs    ?? "200");
const TOOL       = args.tool             ?? "shell_run";
const INPUT      = JSON.parse(args.input ?? '{"command":"sleep","args":["20"]}');
const TIMEOUT_MS = parseInt(args.timeout ?? "90000");

// ── Redis ──────────────────────────────────────────────────────────────────
const STREAM_KEY = "tool-calls";
const GROUP      = "workers";

const pub = new Redis("redis://localhost:6379");
const sub = new Redis("redis://localhost:6379");

// ── Single pattern subscription — one PSUBSCRIBE covers all result channels ─
// Maps channel → { resolve, timer, start }
const pending = new Map();

await sub.psubscribe("result:*");

sub.on("pmessage", (_pattern, ch, msg) => {
  const entry = pending.get(ch);
  if (!entry) return;
  pending.delete(ch);
  clearTimeout(entry.timer);
  const result = JSON.parse(msg);
  entry.resolve({
    status: result.status,
    pod:    result.pod,
    output: result.output,
    ms:     Date.now() - entry.start,
  });
});

// ── helpers ────────────────────────────────────────────────────────────────
const queueDepth = async () => {
  const [p, info, locks] = await Promise.all([
    pub.xpending(STREAM_KEY, GROUP),
    pub.xinfo("GROUPS", STREAM_KEY),
    pub.keys("pod:lock:*"),
  ]);
  const pendingCount = Array.isArray(p) ? Number(p[0] ?? 0) : 0;
  let lag = 0;
  if (Array.isArray(info)) {
    const flat = info.flat();
    const i = flat.indexOf("lag");
    if (i !== -1) lag = Number(flat[i + 1]) || 0;
  }
  return { pending: pendingCount, lag, depth: pendingCount + lag, lockedPods: Array.isArray(locks) ? locks.length : 0 };
};

const fireOne = async (i) => {
  const toolCallId = randomUUID();
  const channel    = `result:${toolCallId}`;
  const start      = Date.now();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(channel)) return;
      pending.delete(channel);
      resolve({ status: "timeout", ms: Date.now() - start });
    }, TIMEOUT_MS);

    pending.set(channel, { resolve, timer, start });

    pub.xadd(STREAM_KEY, "*",
      "toolCallId", toolCallId,
      "tool",       TOOL,
      "input",      JSON.stringify(INPUT),
      "requestId",  randomUUID(),
      "sessionId",  `infra-stress-${i}`,
    );
  });
};

// ── main ───────────────────────────────────────────────────────────────────
try { await pub.xgroup("CREATE", STREAM_KEY, GROUP, "$", "MKSTREAM"); } catch {}

console.log(`\n⚡ Direct infra stress — ${JOBS} x ${TOOL}(${JSON.stringify(INPUT)}), no Claude`);
console.log(`   worker → pod → HPA pipeline  |  timeout=${TIMEOUT_MS / 1000}s\n`);

const promises = Array.from({ length: JOBS }, (_, i) => fireOne(i));

// Fallback poller: pub/sub can drop messages if the pub connection is saturated.
// Worker now also writes result-data:{toolCallId} via a separate Redis connection,
// so we poll that key every 200ms for any job that didn't get its pub/sub delivery.
const fallback = setInterval(async () => {
  if (pending.size === 0) return;
  const channels = [...pending.keys()];
  const keys = channels.map(ch => `result-data:${ch.slice("result:".length)}`);
  try {
    const values = await pub.mget(...keys);
    values.forEach((val, idx) => {
      if (!val) return;
      const ch = channels[idx];
      const entry = pending.get(ch);
      if (!entry) return;
      pending.delete(ch);
      clearTimeout(entry.timer);
      const result = JSON.parse(val);
      entry.resolve({ status: result.status, pod: result.pod, output: result.output, ms: Date.now() - entry.start });
    });
  } catch {}
}, 200);

const poll = setInterval(async () => {
  const s = await queueDepth().catch(() => ({ pending: -1, lag: -1, depth: -1, lockedPods: -1 }));
  const hpaWants = Math.min(32, Math.max(8, Math.ceil(s.depth / 2)));
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] pending=${s.pending} lag=${s.lag} locks=${s.lockedPods}  hpa_wants=${hpaWants}\n`);
}, 3000);

const results = await Promise.all(promises);
clearInterval(fallback);
clearInterval(poll);

const completed = results.filter(r => r.status === "completed");
const failed    = results.filter(r => r.status === "failed");
const timedOut  = results.filter(r => r.status === "timeout");
const avg = (results.reduce((s, r) => s + r.ms, 0) / results.length / 1000).toFixed(1);
const max = (Math.max(...results.map(r => r.ms)) / 1000).toFixed(1);
const min = (Math.min(...results.map(r => r.ms)) / 1000).toFixed(1);
const pods = new Set(results.filter(r => r.pod).map(r => r.pod));
const sample = completed[0]?.output;

console.log(`\n📊 Results:`);
console.log(`   completed : ${completed.length}`);
console.log(`   failed    : ${failed.length}`);
console.log(`   timed out : ${timedOut.length}`);
console.log(`   latency   : min=${min}s  avg=${avg}s  max=${max}s`);
console.log(`   pods used : ${pods.size}  [${[...pods].map(p => p.replace("sandbox-runner-", "")).sort((a,b) => Number(a)-Number(b)).join(", ")}]`);
if (sample) console.log(`   sample    : ${String(sample).slice(0, 100)}`);

await pub.quit();
await sub.quit();
