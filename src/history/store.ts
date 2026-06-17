import { pool } from "./db.js";
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
  async add(record: ExecutionRecord): Promise<void> {
    await pool.query(
      `INSERT INTO executions
         (id, request_id, session_id, tool_call_id, tool, input, output, pod, status, started_at, finished_at, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        record.id,
        record.requestId,
        record.sessionId,
        record.toolCallId,
        record.tool,
        record.input,
        record.output,
        record.pod,
        record.status,
        record.startedAt,
        record.finishedAt,
        record.durationMs,
      ]
    );
  }

  async list(limit = 50, offset = 0): Promise<ExecutionRecord[]> {
    const { rows } = await pool.query(
      "SELECT * FROM executions ORDER BY started_at DESC LIMIT $1 OFFSET $2",
      [limit, offset]
    );
    return rows.map(toRecord);
  }

  async bySession(sessionId: string): Promise<ExecutionRecord[]> {
    const { rows } = await pool.query(
      "SELECT * FROM executions WHERE session_id = $1 ORDER BY started_at DESC",
      [sessionId]
    );
    return rows.map(toRecord);
  }

  async byRequest(requestId: string): Promise<ExecutionRecord[]> {
    const { rows } = await pool.query(
      "SELECT * FROM executions WHERE request_id = $1 ORDER BY started_at DESC",
      [requestId]
    );
    return rows.map(toRecord);
  }

  async count(): Promise<number> {
    const { rows } = await pool.query("SELECT COUNT(*) as n FROM executions");
    return parseInt(rows[0].n, 10);
  }
}

function toRecord(row: Record<string, unknown>): ExecutionRecord {
  return {
    id: row.id as string,
    requestId: row.request_id as string,
    sessionId: row.session_id as string,
    toolCallId: row.tool_call_id as string,
    tool: row.tool as string,
    input: (typeof row.input === "string" ? JSON.parse(row.input) : row.input) as Record<string, unknown>,
    output: row.output as string,
    pod: row.pod as string,
    status: row.status as "completed" | "failed",
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at as string,
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at as string,
    durationMs: row.duration_ms as number,
  };
}

export const executionStore = new ExecutionStore();
