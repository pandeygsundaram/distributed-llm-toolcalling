import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

// Minimal inline store using a temp DB
function makeStore(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY, request_id TEXT, session_id TEXT, tool_call_id TEXT,
      tool TEXT, input TEXT, output TEXT, pod TEXT, status TEXT,
      started_at TEXT, finished_at TEXT, duration_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      tool_calls TEXT, created_at TEXT
    );
  `);

  return {
    addExecution(r: Record<string, unknown>) {
      db.prepare(`INSERT OR REPLACE INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r.id, r.requestId, r.sessionId, r.toolCallId, r.tool,
             JSON.stringify(r.input), r.output, r.pod, r.status,
             r.startedAt, r.finishedAt, r.durationMs);
    },
    listExecutions(limit = 50, offset = 0) {
      return db.prepare("SELECT * FROM executions ORDER BY started_at DESC LIMIT ? OFFSET ?").all(limit, offset);
    },
    countExecutions(): number {
      return (db.prepare("SELECT COUNT(*) as n FROM executions").get() as {n:number}).n;
    },
    addMessage(m: Record<string, unknown>) {
      db.prepare("INSERT OR REPLACE INTO chat_messages VALUES (?,?,?,?,?,?)")
        .run(m.id, m.sessionId, m.role, m.content, m.toolCalls ?? null, m.createdAt);
    },
    getMessages(sessionId: string) {
      return db.prepare("SELECT * FROM chat_messages WHERE session_id=? ORDER BY created_at ASC").all(sessionId);
    },
    getSessions() {
      return db.prepare(`SELECT session_id, MIN(created_at) as created_at, MAX(created_at) as last_at,
        COUNT(*) as count FROM chat_messages WHERE role='user' GROUP BY session_id`).all();
    },
    close() { db.close(); },
  };
}

const dbPath = path.join(os.tmpdir(), `sendai-test-${randomUUID()}.db`);
let store: ReturnType<typeof makeStore>;

beforeAll(() => { store = makeStore(dbPath); });
afterAll(() => { store.close(); });

function makeExec(overrides = {}) {
  return {
    id: randomUUID(), requestId: randomUUID(), sessionId: "sess-1",
    toolCallId: randomUUID(), tool: "shell_run", input: { command: "ls" },
    output: "file.txt", pod: "sandbox-runner-0", status: "completed",
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    durationMs: 100, ...overrides,
  };
}

describe("ExecutionStore (SQLite)", () => {
  it("adds and retrieves execution records", () => {
    store.addExecution(makeExec({ id: "exec-1", sessionId: "sess-exec" }));
    const rows = store.listExecutions();
    const found = (rows as {id:string}[]).find((r) => r.id === "exec-1");
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

  it("stores input as JSON and retrieves it", () => {
    const id = randomUUID();
    store.addExecution(makeExec({ id, input: { command: "ls", args: ["-la"] } }));
    const rows = store.listExecutions(100, 0) as {id:string; input:string}[];
    const found = rows.find((r) => r.id === id);
    expect(JSON.parse(found!.input)).toEqual({ command: "ls", args: ["-la"] });
  });
});

describe("ChatStore (SQLite)", () => {
  it("saves and retrieves messages for a session", () => {
    const sessionId = randomUUID();
    store.addMessage({ id: randomUUID(), sessionId, role: "user", content: "hello", createdAt: new Date().toISOString() });
    store.addMessage({ id: randomUUID(), sessionId, role: "assistant", content: "hi there", createdAt: new Date().toISOString() });
    const msgs = store.getMessages(sessionId) as {role:string}[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
  });

  it("returns sessions with correct metadata", () => {
    const sessionId = randomUUID();
    store.addMessage({ id: randomUUID(), sessionId, role: "user", content: "first message", createdAt: "2025-01-01T00:00:00.000Z" });
    store.addMessage({ id: randomUUID(), sessionId, role: "user", content: "second message", createdAt: "2025-01-01T00:01:00.000Z" });
    const sessions = store.getSessions() as {session_id:string; count:number}[];
    const found = sessions.find((s) => s.session_id === sessionId);
    expect(found).toBeDefined();
    expect(found!.count).toBe(2);
  });

  it("stores and retrieves tool_calls JSON", () => {
    const sessionId = randomUUID();
    const toolCalls = JSON.stringify([{ tool: "shell_run", pod: "sandbox-runner-0" }]);
    store.addMessage({ id: randomUUID(), sessionId, role: "assistant", content: "done", toolCalls, createdAt: new Date().toISOString() });
    const msgs = store.getMessages(sessionId) as {tool_calls:string}[];
    expect(JSON.parse(msgs[0].tool_calls)).toHaveLength(1);
  });

  it("messages are ordered by created_at ASC", () => {
    const sessionId = randomUUID();
    store.addMessage({ id: randomUUID(), sessionId, role: "user", content: "A", createdAt: "2025-01-01T00:00:01.000Z" });
    store.addMessage({ id: randomUUID(), sessionId, role: "assistant", content: "B", createdAt: "2025-01-01T00:00:03.000Z" });
    store.addMessage({ id: randomUUID(), sessionId, role: "user", content: "C", createdAt: "2025-01-01T00:00:02.000Z" });
    const msgs = store.getMessages(sessionId) as {content:string}[];
    expect(msgs.map((m) => m.content)).toEqual(["A", "C", "B"]);
  });
});
