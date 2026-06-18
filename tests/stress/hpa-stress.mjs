const BASE = "http://localhost:3000";
const CONCURRENT = 40;

const fireOne = async (i) => {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: `hpa-stress-${i}`,
        message: "run sleep 25 and tell me when done",
      }),
    });
    const body = await res.json().catch(() => ({}));
    return { i, status: res.status, ms: Date.now() - start, toolCalls: body.toolCalls?.length ?? 0 };
  } catch (e) {
    return { i, status: 0, ms: Date.now() - start, err: e.message };
  }
};

const queueDepth = async () => {
  try {
    const r = await fetch(`${BASE}/metrics`);
    return (await r.json()).queueDepth ?? 0;
  } catch { return -1; }
};

const podCount = async () => {
  try {
    const r = await fetch(`${BASE}/pods`);
    const pods = await r.json();
    return pods.length;
  } catch { return -1; }
};

console.log(`\n🔥 Firing ${CONCURRENT} concurrent requests — each runs sleep 25`);
console.log(`   pods: 8 → up to 32 via HPA as queue fills\n`);

const promises = Array.from({ length: CONCURRENT }, (_, i) => fireOne(i));

const poll = setInterval(async () => {
  const [d, p] = await Promise.all([queueDepth(), podCount()]);
  process.stdout.write(`[${new Date().toISOString().slice(11,19)}] queue_depth=${d}  pods=${p}\n`);
}, 5000);

const results = await Promise.all(promises);
clearInterval(poll);

const ok   = results.filter(r => r.status === 200).length;
const r429 = results.filter(r => r.status === 429).length;
const err  = results.filter(r => r.status >= 500 || r.status === 0).length;
const toolOk = results.filter(r => (r.toolCalls ?? 0) > 0).length;
const avg  = (results.reduce((s, r) => s + r.ms, 0) / results.length / 1000).toFixed(1);
const max  = (Math.max(...results.map(r => r.ms)) / 1000).toFixed(1);
const min  = (Math.min(...results.map(r => r.ms)) / 1000).toFixed(1);

console.log(`\n📊 Load test done:`);
console.log(`   200 ok    : ${ok}  (${toolOk} with tool calls)`);
console.log(`   429       : ${r429}`);
console.log(`   5xx/err   : ${err}`);
console.log(`   latency   : min=${min}s  avg=${avg}s  max=${max}s`);
