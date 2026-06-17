/**
 * Integration tests — require the server to be running on localhost:3000
 * and Redis + K8s pods to be available.
 *
 * Run: npm run test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:3000";

async function get(path: string) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
}

async function post(path: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ─── Health ──────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns ok", async () => {
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("reports kubernetes connected", async () => {
    const { body } = await get("/health");
    expect(body.kubernetes).toBe("connected");
  });

  it("reports sandboxPodsReady = 8", async () => {
    const { body } = await get("/health");
    expect(body.sandboxPodsReady).toBe(8);
  });
});

// ─── Pods ────────────────────────────────────────────────────────────────────

describe("GET /pods", () => {
  it("returns 8 pods", async () => {
    const { status, body } = await get("/pods");
    expect(status).toBe(200);
    expect(body.pods).toHaveLength(8);
  });

  it("each pod has a name and lease status", async () => {
    const { body } = await get("/pods");
    for (const pod of body.pods) {
      expect(pod.name).toMatch(/^sandbox-runner-\d$/);
      expect(["free", "leased", "unknown"]).toContain(pod.lease.status);
    }
  });

  it("includes queue info", async () => {
    const { body } = await get("/pods");
    expect(typeof body.queue.depth).toBe("number");
    expect(typeof body.queue.estimatedWaitMs).toBe("number");
  });

  it("pods are initially all free", async () => {
    const { body } = await get("/pods");
    const free = body.pods.filter((p: {lease:{status:string}}) => p.lease.status === "free");
    expect(free.length).toBeGreaterThanOrEqual(7); // allow 1 that might be in use
  });
});

// ─── Metrics ─────────────────────────────────────────────────────────────────

describe("GET /metrics", () => {
  it("returns metrics snapshot", async () => {
    const { status, body } = await get("/metrics");
    expect(status).toBe(200);
    expect(body.window).toBe("5m");
    expect(typeof body.queueDepth).toBe("number");
    expect(typeof body.podsInUse).toBe("number");
    expect(typeof body.tools).toBe("object");
    expect(typeof body.generatedAt).toBe("string");
  });
});

// ─── Executions ──────────────────────────────────────────────────────────────

describe("GET /executions", () => {
  it("returns execution list", async () => {
    const { status, body } = await get("/executions");
    expect(status).toBe(200);
    expect(Array.isArray(body.executions)).toBe(true);
  });

  it("respects limit param", async () => {
    const { body } = await get("/executions?limit=5");
    expect(body.executions.length).toBeLessThanOrEqual(5);
  });

  it("returns total count", async () => {
    const { body } = await get("/executions");
    expect(typeof body.total).toBe("number");
  });
});

// ─── Chats ───────────────────────────────────────────────────────────────────

describe("GET /chats", () => {
  it("returns sessions list", async () => {
    const { status, body } = await get("/chats");
    expect(status).toBe(200);
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});

// ─── Chat endpoint validation ─────────────────────────────────────────────────

describe("POST /chat — validation", () => {
  it("rejects missing sessionId", async () => {
    const { status } = await post("/chat", { message: "hello" });
    expect(status).toBe(400);
  });

  it("rejects missing message", async () => {
    const { status } = await post("/chat", { sessionId: "test" });
    expect(status).toBe(400);
  });

  it("rejects empty body", async () => {
    const { status } = await post("/chat", {});
    expect(status).toBe(400);
  });
});

// ─── Cancel ──────────────────────────────────────────────────────────────────

describe("POST /cancel/:requestId", () => {
  it("returns 404 for unknown requestId", async () => {
    const { status, body } = await post("/cancel/nonexistent-id", {});
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
  });
});

// ─── Full chat round-trip (no AI — direct tool test) ─────────────────────────

describe("POST /chat — tool execution round-trip", () => {
  const sessionId = `test-integration-${Date.now()}`;

  it("executes shell_run and returns real pod output", async () => {
    const { status, body } = await post("/chat", {
      sessionId,
      message: "run ls in the sandbox and tell me what is there",
    });
    expect(status).toBe(200);
    expect(body.sessionId).toBe(sessionId);
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.toolCalls).toBeDefined();
    expect(body.toolCalls.length).toBeGreaterThan(0);

    const tc = body.toolCalls[0];
    expect(tc.tool).toBe("shell_run");
    expect(tc.status).toBe("completed");
    expect(tc.pod).toMatch(/^sandbox-runner-\d$/);
    expect(tc.durationMs).toBeGreaterThan(0);
  }, 45_000);

  it("saves chat to history — GET /chats/:sessionId returns messages", async () => {
    await post("/chat", { sessionId, message: "what pod am I on?" });

    const { status, body } = await get(`/chats/${sessionId}`);
    expect(status).toBe(200);
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    expect(body.messages.some((m: {role:string}) => m.role === "user")).toBe(true);
    expect(body.messages.some((m: {role:string}) => m.role === "assistant")).toBe(true);
  }, 45_000);

  it("session appears in GET /chats list", async () => {
    const { body } = await get("/chats");
    const found = body.sessions.find((s: {sessionId:string}) => s.sessionId === sessionId);
    expect(found).toBeDefined();
    expect(found.messageCount).toBeGreaterThan(0);
  }, 45_000);

  it("execution appears in GET /executions", async () => {
    const { body } = await get(`/executions?sessionId=${sessionId}`);
    expect(body.executions.length).toBeGreaterThan(0);
    const exec = body.executions[0];
    expect(exec.tool).toBeDefined();
    expect(exec.pod).toMatch(/^sandbox-runner-\d$/);
    expect(exec.durationMs).toBeGreaterThan(0);
    expect(exec.status).toBe("completed");
  }, 45_000);

  it("metrics update after tool calls", async () => {
    const { body } = await get("/metrics");
    expect(typeof body.tools).toBe("object");
    const toolNames = Object.keys(body.tools);
    expect(toolNames.length).toBeGreaterThan(0);
    const firstTool = body.tools[toolNames[0]];
    expect(firstTool.count).toBeGreaterThan(0);
  }, 45_000);
});

// ─── Pod assignment — two calls never share a pod ─────────────────────────────

describe("Concurrent pod assignment", () => {
  it("two simultaneous calls land on different pods", async () => {
    const [r1, r2] = await Promise.all([
      post("/chat", { sessionId: `conc-1-${Date.now()}`, message: "run pwd" }),
      post("/chat", { sessionId: `conc-2-${Date.now()}`, message: "run pwd" }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const pod1 = r1.body.toolCalls?.[0]?.pod;
    const pod2 = r2.body.toolCalls?.[0]?.pod;
    expect(pod1).toBeDefined();
    expect(pod2).toBeDefined();
    expect(pod1).not.toBe(pod2); // LRU should route them differently
  }, 60_000);
});
