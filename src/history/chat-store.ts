import Database from "better-sqlite3";
import path from "path";
import { logger } from "../logger.js";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: string; // JSON stringified
  createdAt: string;
}

export interface ChatSession {
  sessionId: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

class ChatStore {
  private db: Database.Database;

  constructor() {
    const dbPath = path.resolve(process.cwd(), "executions.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at DESC);
    `);
    logger.info("chat-store.ready");
  }

  addMessage(msg: ChatMessage) {
    this.db.prepare(`
      INSERT OR REPLACE INTO chat_messages (id, session_id, role, content, tool_calls, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(msg.id, msg.sessionId, msg.role, msg.content, msg.toolCalls ?? null, msg.createdAt);
  }

  getMessages(sessionId: string): ChatMessage[] {
    return (this.db.prepare(
      "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC"
    ).all(sessionId) as RawRow[]).map(toMessage);
  }

  getSessions(): ChatSession[] {
    return (this.db.prepare(`
      SELECT
        session_id,
        MIN(content) as title_src,
        MIN(created_at) as created_at,
        MAX(created_at) as last_message_at,
        COUNT(*) as message_count
      FROM chat_messages
      WHERE role = 'user'
      GROUP BY session_id
      ORDER BY MAX(created_at) DESC
    `).all() as RawSession[]).map(toSession);
  }

  deleteSession(sessionId: string) {
    this.db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(sessionId);
  }
}

interface RawRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: string;
}

interface RawSession {
  session_id: string;
  title_src: string;
  created_at: string;
  last_message_at: string;
  message_count: number;
}

function toMessage(row: RawRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as "user" | "assistant",
    content: row.content,
    toolCalls: row.tool_calls ?? undefined,
    createdAt: row.created_at,
  };
}

function toSession(row: RawSession): ChatSession {
  const title = row.title_src?.slice(0, 60) + (row.title_src?.length > 60 ? "…" : "");
  return {
    sessionId: row.session_id,
    title,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
  };
}

export const chatStore = new ChatStore();
