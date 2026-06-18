import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";

export const register = new Registry();
collectDefaultMetrics({ register });

export const toolCallsTotal = new Counter({
  name: "tool_calls_total",
  help: "Total number of tool calls",
  labelNames: ["tool", "status"] as const,
  registers: [register],
});

export const toolCallDurationMs = new Histogram({
  name: "tool_call_duration_ms",
  help: "Tool call duration in milliseconds",
  labelNames: ["tool"] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [register],
});

export const queueDepthGauge = new Gauge({
  name: "queue_depth",
  help: "Number of jobs waiting for a pod",
  registers: [register],
});

export const podsInUseGauge = new Gauge({
  name: "pods_in_use",
  help: "Number of pods currently holding Redis locks",
  registers: [register],
});

export const queueWaitMs = new Histogram({
  name: "queue_wait_ms",
  help: "Time spent waiting in queue before pod acquired",
  buckets: [100, 500, 1000, 2000, 5000, 10000, 15000],
  registers: [register],
});

export const dlqTotal = new Counter({
  name: "dlq_total",
  help: "Total jobs sent to dead letter queue",
  labelNames: ["tool"] as const,
  registers: [register],
});

// In-memory rolling stats for the dashboard (SSE metrics_update)
interface Sample { value: number; ts: number }

const WINDOW_MS = 5 * 60 * 1000;
const toolSamples = new Map<string, Sample[]>();
const queueWaitSamples: Sample[] = [];
let _queueDepth = 0;
let _podsInUse = 0;

// Rolling queue-depth history for the sparkline (last 60 points at 200ms = 12s)
const QDEPTH_HISTORY_MAX = 120;
const queueDepthHistory: { ts: number; v: number }[] = [];

function prune(arr: Sample[]) {
  const cutoff = Date.now() - WINDOW_MS;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function stats(samples: Sample[]) {
  const vals = [...samples].map((s) => s.value).sort((a, b) => a - b);
  return {
    count: vals.length,
    p50: percentile(vals, 50),
    p95: percentile(vals, 95),
    p99: percentile(vals, 99),
    avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0,
  };
}

export const metrics = {
  recordToolExecution(tool: string, durationMs: number, status: "completed" | "failed" = "completed") {
    toolCallsTotal.inc({ tool, status });
    toolCallDurationMs.observe({ tool }, durationMs);

    if (!toolSamples.has(tool)) toolSamples.set(tool, []);
    const arr = toolSamples.get(tool)!;
    arr.push({ value: durationMs, ts: Date.now() });
    prune(arr);
  },

  recordQueueWait(ms: number) {
    queueWaitMs.observe(ms);
    queueWaitSamples.push({ value: ms, ts: Date.now() });
    prune(queueWaitSamples);
  },

  setQueueDepth(n: number) {
    _queueDepth = n;
    queueDepthGauge.set(n);
    queueDepthHistory.push({ ts: Date.now(), v: n });
    if (queueDepthHistory.length > QDEPTH_HISTORY_MAX) queueDepthHistory.shift();
  },

  setPodsInUse(n: number) {
    _podsInUse = n;
    podsInUseGauge.set(n);
  },

  snapshot() {
    const toolStats: Record<string, ReturnType<typeof stats> & { totalMs: number }> = {};
    let totalRecentCalls = 0;
    const now = Date.now();
    const throughputWindowMs = 10_000;
    for (const [tool, samples] of toolSamples) {
      prune(samples);
      const totalMs = samples.reduce((s, x) => s + x.value, 0);
      toolStats[tool] = { ...stats(samples), totalMs };
      totalRecentCalls += samples.filter(s => s.ts > now - throughputWindowMs).length;
    }
    const callsPerSec = Math.round((totalRecentCalls / (throughputWindowMs / 1000)) * 10) / 10;

    return {
      window: "5m",
      queueDepth: _queueDepth,
      podsInUse: _podsInUse,
      callsPerSec,
      queueWait: stats(queueWaitSamples),
      tools: toolStats,
      queueDepthHistory: [...queueDepthHistory],
      generatedAt: new Date().toISOString(),
    };
  },
};
