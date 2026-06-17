import { pool } from "./db.js";
import { logger } from "../logger.js";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: string;
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
  async addMessage(msg: ChatMessage): Promise<void> {
    await pool.query(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_calls, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [
        msg.id,
        msg.sessionId,
        msg.role,
        msg.content,
        msg.toolCalls ?? null,
        msg.createdAt,
      ]
    );
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const { rows } = await pool.query(
      "SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
      [sessionId]
    );
    return rows.map(toMessage);
  }

  async getSessions(): Promise<ChatSession[]> {
    const { rows } = await pool.query(`
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
    `);
    return rows.map(toSession);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await pool.query("DELETE FROM chat_messages WHERE session_id = $1", [sessionId]);
  }
}

function toMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    role: row.role as "user" | "assistant",
    content: row.content as string,
    toolCalls: row.tool_calls ? (row.tool_calls as string) : undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at as string,
  };
}

function toSession(row: Record<string, unknown>): ChatSession {
  const titleSrc = row.title_src as string ?? "";
  const title = titleSrc.slice(0, 60) + (titleSrc.length > 60 ? "…" : "");
  return {
    sessionId: row.session_id as string,
    title,
    messageCount: parseInt(row.message_count as string, 10),
    lastMessageAt: row.last_message_at instanceof Date
      ? (row.last_message_at as Date).toISOString()
      : row.last_message_at as string,
    createdAt: row.created_at instanceof Date
      ? (row.created_at as Date).toISOString()
      : row.created_at as string,
  };
}

export const chatStore = new ChatStore();
