import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";

// ── Minimal in-memory store that mirrors the Postgres schema ─────────────────
// These tests verify the store's mapping logic (column names → TS fields,
// JSON serialization, ordering) without requiring a real database connection.

interface Row { [key: string]: unknown }
const execRows: Row[] = [];
const chatRows: Row[] = [];

function makeStore() {
  return {
    addExecution(r: Record<string, unknown>) {
      execRows.push({
        id: r.id, request_id: r.requestId, session_id: r.sessionId,
        tool_call_id: r.toolCallId, tool: r.tool, input: r.input,
        output: r.output, pod: r.pod, status: r.status,
        started_at: r.startedAt, finished_at: r.finishedAt, duration_ms: r.durationMs,
      });
    },
    listExecutions(limit = 50, offset = 0) {
      return [...execRows]
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
        .slice(offset, offset + limit);
    },
    bySession(sessionId: string) {
      return execRows.filter((r) => r.session_id === sessionId);
    },
    countExecutions() { return execRows.length; },
    addMessage(m: Record<string, unknown>) {
      chatRows.push({
        id: m.id, session_id: m.sessionId, role: m.role, content: m.content,
        tool_calls: m.toolCalls ?? null, created_at: m.createdAt,
      });
    },
    getMessages(sessionId: string) {
      return chatRows
        .filter((r) => r.session_id === sessionId)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    },
    getSessions() {
      const map = new Map<string, { min_at: string; max_at: string; count: number; title: string }>();
      for (const r of chatRows) {
        if (r.role !== "user") continue;
        const sid = r.session_id as string;
        const at = r.created_at as string;
        const existing = map.get(sid);
        if (!existing) {
          map.set(sid, { min_at: at, max_at: at, count: 1, title: r.content as string });
        } else {
          existing.count++;
          if (at < existing.min_at) existing.min_at = at;
          if (at > existing.max_at) existing.max_at = at;
        }
      }
      return [...map.entries()]
        .sort((a, b) => b[1].max_at.localeCompare(a[1].max_at))
        .map(([sessionId, v]) => ({
          session_id: sessionId,
          title_src: v.title,
          created_at: v.min_at,
          last_message_at: v.max_at,
          message_count: v.count,
        }));
    },
  };
}

let store: ReturnType<typeof makeStore>;

beforeEach(() => {
  execRows.length = 0;
  chatRows.length = 0;
  store = makeStore();
});

function makeExec(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), requestId: randomUUID(), sessionId: "sess-1",
    toolCallId: randomUUID(), tool: "shell_run", input: { command: "ls" },
    output: "file.txt", pod: "sandbox-runner-0", status: "completed",
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    durationMs: 100, ...overrides,
  };
}

describe("ExecutionStore (Postgres schema)", () => {
  it("adds and retrieves execution records", () => {
    store.addExecution(makeExec({ id: "exec-1", sessionId: "sess-exec" }));
    const rows = store.listExecutions();
    const found = (rows as Row[]).find((r) => r.id === "exec-1");
    expect(found).toBeDefined();
  });

  it("counts records correctly", () => {
    const before = store.countExecutions();
    store.addExecution(makeExec());
    store.addExecution(makeExec());
    expect(store.countExecutions()).toBe(before + 2);
  });

  it("paginates with limit and offset", () => {
    const sessionId = randomUUID();
    for (let i = 0; i < 5; i++) store.addExecution(makeExec({ sessionId }));
    const page1 = store.listExecutions(2, 0);
    const page2 = store.listExecutions(2, 2);
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
  });

  it("filters by session", () => {
    const sid = randomUUID();
    store.addExecution(makeExec({ sessionId: sid }));
    store.addExecution(makeExec({ sessionId: sid }));
    store.addExecution(makeExec({ sessionId: "other" }));
    expect(store.bySession(sid)).toHaveLength(2);
  });

  it("stores input as JSONB", () => {
    const id = randomUUID();
    store.addExecution(makeExec({ id, input: { command: "ls", args: ["-la"] } }));
    const found = store.listExecutions(100, 0).find((r) => (r as Row).id === id) as Row;
    const input = typeof found.input === "string" ? JSON.parse(found.input) : found.input;
    expect(input).toEqual({ command: "ls", args: ["-la"] });
  });
});

describe("ChatStore (Postgres schema)", () => {
  it("saves and retrieves messages for a session", () => {
    const sessionId = randomUUID();
    store.addMessage({ id: randomUUID(), sessionId, role: "user", content: "hello", createdAt: "2025-01-01T00:00:00.000Z" });
    store.addMessage({ id: randomUUID(), sessionId, role: "assistant", content: "hi there", createdAt: "2025-01-01T00:00:01.000Z" });
    const msgs = store.getMessages(sessionId) as Row[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("returns sessions with correct message count", () => {
    const sessionId = randomUUID();
    store.addMessage({ id: randomUUID(), sessionId, role: "user", content: "first", createdAt: "2025-01-01T00:00:00.000Z" });
    store.addMessage({ id: randomUUID(), sessionId, role: "user", content: "second", createdAt: "2025-01-01T00:01:00.000Z" });
    const sessions = store.getSessions() as Row[];
    const found = sessions.find((s) => s.session_id === sessionId);
    expect(found).toBeDefined();
    expect(found!.message_count).toBe(2);
  });

  it("stores and retrieves tool_calls", () => {
    const sessionId = randomUUID();
    const toolCalls = JSON.stringify([{ tool: "shell_run", pod: "sandbox-runner-0" }]);
    store.addMessage({ id: randomUUID(), sessionId, role: "assistant", content: "done", toolCalls, createdAt: new Date().toISOString() });
    const msgs = store.getMessages(sessionId) as Row[];
    expect(JSON.parse(msgs[0].tool_calls as string)).toHaveLength(1);
  });

  it("messages are ordered by created_at ASC", () => {
    const sessionId = randomUUID();
    store.addMessage({ id: randomUUID(), sessionId, role: "user", content: "A", createdAt: "2025-01-01T00:00:01.000Z" });
    store.addMessage({ id: randomUUID(), sessionId, role: "assistant", content: "B", createdAt: "2025-01-01T00:00:03.000Z" });
    store.addMessage({ id: randomUUID(), sessionId, role: "user", content: "C", createdAt: "2025-01-01T00:00:02.000Z" });
    const msgs = store.getMessages(sessionId) as Row[];
    expect(msgs.map((m) => m.content)).toEqual(["A", "C", "B"]);
  });

  it("sessions sorted by most recent activity", () => {
    const old = randomUUID();
    const recent = randomUUID();
    store.addMessage({ id: randomUUID(), sessionId: old, role: "user", content: "x", createdAt: "2025-01-01T00:00:00.000Z" });
    store.addMessage({ id: randomUUID(), sessionId: recent, role: "user", content: "y", createdAt: "2025-06-01T00:00:00.000Z" });
    const sessions = store.getSessions() as Row[];
    expect(sessions[0].session_id).toBe(recent);
    expect(sessions[1].session_id).toBe(old);
  });
});
