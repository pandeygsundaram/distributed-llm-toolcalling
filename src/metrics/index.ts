interface Sample {
  value: number;
  ts: number;
}

interface ToolMetric {
  count: number;
  totalMs: number;
  samples: Sample[];
}

const WINDOW_MS = 5 * 60 * 1000; // 5 minute rolling window

class MetricsCollector {
  private tools: Map<string, ToolMetric> = new Map();
  private queueWaits: Sample[] = [];
  private leaseAcquires: Sample[] = [];
  private queueDepth = 0;
  private podsInUse = 0;

  private getOrCreate(tool: string): ToolMetric {
    if (!this.tools.has(tool)) {
      this.tools.set(tool, { count: 0, totalMs: 0, samples: [] });
    }
    return this.tools.get(tool)!;
  }

  recordToolExecution(tool: string, durationMs: number) {
    const m = this.getOrCreate(tool);
    m.count++;
    m.totalMs += durationMs;
    m.samples.push({ value: durationMs, ts: Date.now() });
    this.prune(m.samples);
  }

  recordQueueWait(ms: number) {
    this.queueWaits.push({ value: ms, ts: Date.now() });
    this.prune(this.queueWaits);
  }

  recordLeaseAcquire(ms: number) {
    this.leaseAcquires.push({ value: ms, ts: Date.now() });
    this.prune(this.leaseAcquires);
  }

  setQueueDepth(n: number) { this.queueDepth = n; }
  setPodsInUse(n: number) { this.podsInUse = n; }

  private prune(arr: Sample[]) {
    const cutoff = Date.now() - WINDOW_MS;
    while (arr.length && arr[0].ts < cutoff) arr.shift();
  }

  private percentile(sorted: number[], p: number): number {
    if (!sorted.length) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  private stats(samples: Sample[]) {
    const vals = [...samples].map(s => s.value).sort((a, b) => a - b);
    return {
      count: vals.length,
      p50: this.percentile(vals, 50),
      p95: this.percentile(vals, 95),
      p99: this.percentile(vals, 99),
      avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0,
    };
  }

  snapshot() {
    const toolStats: Record<string, ReturnType<MetricsCollector["stats"]> & { totalMs: number }> = {};
    for (const [tool, m] of this.tools) {
      toolStats[tool] = { ...this.stats(m.samples), totalMs: m.totalMs };
    }

    return {
      window: "5m",
      queueDepth: this.queueDepth,
      podsInUse: this.podsInUse,
      queueWait: this.stats(this.queueWaits),
      leaseAcquire: this.stats(this.leaseAcquires),
      tools: toolStats,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const metrics = new MetricsCollector();
