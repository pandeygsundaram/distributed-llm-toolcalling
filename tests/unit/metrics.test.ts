import { describe, it, expect, beforeEach } from "vitest";

// Inline a testable version so we don't hit the singleton
class MetricsCollector {
  private executions: { tool: string; durationMs: number; ts: number }[] = [];
  private readonly windowMs = 5 * 60 * 1000;
  private podsInUse = 0;
  private totalRequests = 0;
  private totalToolExecutions = 0;

  recordToolExecution(tool: string, durationMs: number) {
    this.executions.push({ tool, durationMs, ts: Date.now() });
    this.totalToolExecutions++;
  }

  incrementRequests() { this.totalRequests++; }
  setPodsInUse(n: number) { this.podsInUse = n; }

  private prune() {
    const cutoff = Date.now() - this.windowMs;
    this.executions = this.executions.filter((e) => e.ts > cutoff);
  }

  private percentile(sorted: number[], p: number): number {
    if (!sorted.length) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  snapshot() {
    this.prune();
    const durations = this.executions.map((e) => e.durationMs).sort((a, b) => a - b);
    return {
      totalRequests: this.totalRequests,
      totalToolExecutions: this.totalToolExecutions,
      p50Ms: this.percentile(durations, 50),
      p95Ms: this.percentile(durations, 95),
      p99Ms: this.percentile(durations, 99),
      podsInUse: this.podsInUse,
    };
  }
}

describe("MetricsCollector", () => {
  let m: MetricsCollector;

  beforeEach(() => { m = new MetricsCollector(); });

  it("starts at zero", () => {
    const s = m.snapshot();
    expect(s.totalRequests).toBe(0);
    expect(s.totalToolExecutions).toBe(0);
    expect(s.p50Ms).toBe(0);
  });

  it("counts tool executions", () => {
    m.recordToolExecution("shell_run", 100);
    m.recordToolExecution("fs_read", 200);
    expect(m.snapshot().totalToolExecutions).toBe(2);
  });

  it("calculates p50 correctly", () => {
    for (const ms of [100, 200, 300, 400, 500]) m.recordToolExecution("t", ms);
    expect(m.snapshot().p50Ms).toBe(300);
  });

  it("calculates p95 on skewed data", () => {
    for (let i = 1; i <= 100; i++) m.recordToolExecution("t", i * 10);
    const s = m.snapshot();
    expect(s.p95Ms).toBe(950);
    expect(s.p99Ms).toBe(990);
  });

  it("tracks podsInUse", () => {
    m.setPodsInUse(3);
    expect(m.snapshot().podsInUse).toBe(3);
    m.setPodsInUse(0);
    expect(m.snapshot().podsInUse).toBe(0);
  });

  it("handles single execution", () => {
    m.recordToolExecution("shell_run", 150);
    const s = m.snapshot();
    expect(s.p50Ms).toBe(150);
    expect(s.p95Ms).toBe(150);
    expect(s.p99Ms).toBe(150);
  });
});
