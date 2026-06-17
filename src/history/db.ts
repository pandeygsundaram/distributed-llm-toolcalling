import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });

pool.on("error", (err) => logger.error({ err }, "pg.pool.error"));

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      input JSONB NOT NULL,
      output TEXT NOT NULL,
      pod TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL,
      duration_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exec_session ON executions(session_id);
    CREATE INDEX IF NOT EXISTS idx_exec_request ON executions(request_id);
    CREATE INDEX IF NOT EXISTS idx_exec_started ON executions(started_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls JSONB,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at DESC);
  `);
  logger.info({ url: config.DATABASE_URL.replace(/:[^:@]+@/, ":***@") }, "postgres.db.ready");
}
