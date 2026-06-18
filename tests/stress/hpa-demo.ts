// HPA demo load: fires 25 concurrent requests each running "sleep 20"
// With only 8 pods, 17 requests queue up → queue_depth rises → HPA scales

import { setTimeout as sleep } from "timers/promises";

const BASE = "http://localhost:3000";
const CONCURRENT = 25;
const SESSION = `hpa-demo-${Date.now()}`;

async function fireOne(i: number): Promise<{ status: number; durationMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: `${SESSION}-${i}`,
        message: "run this shell command: sleep 20",
      }),
    });
    return { status: res.status, durationMs: Date.now() - start };
  } catch {
    return { status: 0, durationMs: Date.now() - start };
  }
}

async function pollQueueDepth(): Promise<number> {
  try {
    const res = await fetch(`${BASE}/metrics`);
    const d = await res.json() as { queueDepth: number };
    return d.queueDepth ?? 0;
  } catch { return -1; }
}

async function main() {
  console.log(`\n🚀 Firing ${CONCURRENT} concurrent requests (each runs sleep 20)\n`);
  console.log("BEFORE  pods=8  queue_depth=0\n");

  // Fire all requests in parallel — don't await yet
  const promises = Array.from({ length: CONCURRENT }, (_, i) => fireOne(i));

  // Poll queue depth every 3s while requests run
  const pollInterval = setInterval(async () => {
    const depth = await pollQueueDepth();
    const ts = new Date().toISOString().slice(11, 19);
    process.stdout.write(`[${ts}]  queue_depth=${depth}\n`);
  }, 3000);

  // Wait for all to finish
  const results = await Promise.all(promises);
  clearInterval(pollInterval);

  const ok    = results.filter(r => r.status === 200).length;
  const r429  = results.filter(r => r.status === 429).length;
  const err   = results.filter(r => r.status >= 500 || r.status === 0).length;
  const avgMs = Math.round(results.reduce((s, r) => s + r.durationMs, 0) / results.length);
  const maxMs = Math.max(...results.map(r => r.durationMs));

  console.log(`\n✅ Results:`);
  console.log(`  200 ok       : ${ok}`);
  console.log(`  429 queued   : ${r429}`);
  console.log(`  5xx/err      : ${err}`);
  console.log(`  avg latency  : ${(avgMs/1000).toFixed(1)}s`);
  console.log(`  max latency  : ${(maxMs/1000).toFixed(1)}s`);
}

main().catch(console.error);
