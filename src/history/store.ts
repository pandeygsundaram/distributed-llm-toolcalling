import Database from "better-sqlite3";
import path from "path";
import { logger } from "../logger.js";

export interface ExecutionRecord {
  id: string;
  requestId: string;
  sessionId: string;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  pod: string;
  status: "completed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

class ExecutionStore {
  private db: Database.Database;

  constructor() {
    const dbPath = path.resolve(process.cwd(), "executions.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        pod TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session ON executions(session_id);
      CREATE INDEX IF NOT EXISTS idx_request ON executions(request_id);
      CREATE INDEX IF NOT EXISTS idx_started ON executions(started_at DESC);
    `);
    logger.info({ dbPath }, "sqlite.store.ready");
  }

  add(record: ExecutionRecord) {
    this.db.prepare(`
      INSERT OR REPLACE INTO executions
        (id, request_id, session_id, tool_call_id, tool, input, output, pod, status, started_at, finished_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.requestId,
      record.sessionId,
      record.toolCallId,
      record.tool,
      JSON.stringify(record.input),
      record.output,
      record.pod,
      record.status,
      record.startedAt,
      record.finishedAt,
      record.durationMs,
    );
  }

  list(limit = 50, offset = 0): ExecutionRecord[] {
    return (this.db.prepare(
      "SELECT * FROM executions ORDER BY started_at DESC LIMIT ? OFFSET ?"
    ).all(limit, offset) as RawRow[]).map(toRecord);
  }

  bySession(sessionId: string): ExecutionRecord[] {
    return (this.db.prepare(
      "SELECT * FROM executions WHERE session_id = ? ORDER BY started_at DESC"
    ).all(sessionId) as RawRow[]).map(toRecord);
  }

  byRequest(requestId: string): ExecutionRecord[] {
    return (this.db.prepare(
      "SELECT * FROM executions WHERE request_id = ? ORDER BY started_at DESC"
    ).all(requestId) as RawRow[]).map(toRecord);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM executions").get() as { n: number }).n;
  }
}

interface RawRow {
  id: string;
  request_id: string;
  session_id: string;
  tool_call_id: string;
  tool: string;
  input: string;
  output: string;
  pod: string;
  status: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

function toRecord(row: RawRow): ExecutionRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    tool: row.tool,
    input: JSON.parse(row.input),
    output: row.output,
    pod: row.pod,
    status: row.status as "completed" | "failed",
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  };
}

export const executionStore = new ExecutionStore();
