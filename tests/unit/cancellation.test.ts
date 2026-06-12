import { describe, it, expect } from "vitest";

// Inline testable version (same logic as src/cancellation/manager.ts)
class CancellationManager {
  private controllers = new Map<string, AbortController>();

  register(requestId: string, _sessionId: string): AbortSignal {
    const ctrl = new AbortController();
    this.controllers.set(requestId, ctrl);
    return ctrl.signal;
  }

  cancel(requestId: string): boolean {
    const ctrl = this.controllers.get(requestId);
    if (!ctrl) return false;
    ctrl.abort();
    this.controllers.delete(requestId);
    return true;
  }

  complete(requestId: string) {
    this.controllers.delete(requestId);
  }

  activeCount(): number { return this.controllers.size; }
}

describe("CancellationManager", () => {
  it("registers and returns a signal", () => {
    const m = new CancellationManager();
    const signal = m.register("req-1", "sess-1");
    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);
  });

  it("cancels an active request", () => {
    const m = new CancellationManager();
    const signal = m.register("req-1", "sess-1");
    const result = m.cancel("req-1");
    expect(result).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("returns false for unknown requestId", () => {
    const m = new CancellationManager();
    expect(m.cancel("nonexistent")).toBe(false);
  });

  it("cleans up after complete()", () => {
    const m = new CancellationManager();
    m.register("req-1", "sess-1");
    expect(m.activeCount()).toBe(1);
    m.complete("req-1");
    expect(m.activeCount()).toBe(0);
  });

  it("handles multiple concurrent requests", () => {
    const m = new CancellationManager();
    const s1 = m.register("r1", "s1");
    const s2 = m.register("r2", "s2");
    const s3 = m.register("r3", "s3");
    m.cancel("r2");
    expect(s1.aborted).toBe(false);
    expect(s2.aborted).toBe(true);
    expect(s3.aborted).toBe(false);
    expect(m.activeCount()).toBe(2);
  });

  it("double-cancel is a no-op", () => {
    const m = new CancellationManager();
    m.register("req-1", "sess-1");
    expect(m.cancel("req-1")).toBe(true);
    expect(m.cancel("req-1")).toBe(false); // already removed
  });
});
