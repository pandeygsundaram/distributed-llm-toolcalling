const BASE = "http://localhost:3000";
const CONCURRENT = 1000;
const BATCH = 50; // fire in batches to not overwhelm Node.js fetch

const fireOne = async (i) => {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: `storm-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
        message: "run sleep 25 and tell me when done",
      }),
    });
    const body = await res.json().catch(() => ({}));
    return { i, status: res.status, ms: Date.now() - start, tool: (body.toolCalls?.length ?? 0) > 0 };
  } catch (e) {
    return { i, status: 0, ms: Date.now() - start, err: e.message };
  }
};

const stat = async () => {
  try {
    const [m, h] = await Promise.all([
      fetch(`${BASE}/metrics`).then(r => r.json()),
      fetch(`${BASE}/health`).then(r => r.json()),
    ]);
    return { q: m.queueDepth ?? 0, pods: h.sandboxPodsReady ?? "?" };
  } catch { return { q: -1, pods: "?" }; }
};

console.log(`\n🔥 Firing ${CONCURRENT} concurrent requests — each runs sleep 25`);
console.log(`   HPA: 8 → 32 pods  |  scale logic: desired = ceil(queue_depth / 2), +4 pods/30s\n`);

// Fire all at once in batches
const allPromises = [];
for (let i = 0; i < CONCURRENT; i += BATCH) {
  const batch = Array.from({ length: Math.min(BATCH, CONCURRENT - i) }, (_, j) => fireOne(i + j));
  allPromises.push(...batch);
  await new Promise(r => setTimeout(r, 50)); // tiny stagger between batches
}

const poll = setInterval(async () => {
  const { q, pods } = await stat();
  const desired = Math.min(32, Math.max(8, Math.ceil(q / 2)));
  process.stdout.write(`[${new Date().toISOString().slice(11,19)}] queue=${q}  pods=${pods}  hpa_wants=${desired}\n`);
}, 5000);

const results = await Promise.all(allPromises);
clearInterval(poll);

const ok   = results.filter(r => r.status === 200).length;
const r429 = results.filter(r => r.status === 429).length;
const err  = results.filter(r => r.status >= 500 || r.status === 0).length;
const tool = results.filter(r => r.tool).length;
const avg  = (results.reduce((s, r) => s + r.ms, 0) / results.length / 1000).toFixed(1);
const max  = (Math.max(...results.map(r => r.ms)) / 1000).toFixed(1);

console.log(`\n📊 Done:`);
console.log(`   200 ok  : ${ok}  (${tool} ran tool)`);
console.log(`   429     : ${r429}  (queue timeout)`);
console.log(`   err     : ${err}`);
console.log(`   avg/max : ${avg}s / ${max}s`);
