import { Router } from "express";
import { chatStore } from "../history/chat-store.js";

export function registerChatHistoryRoutes(): Router {
  const router = Router();

  // List all sessions
  router.get("/chats", (_req, res) => {
    res.json({ sessions: chatStore.getSessions() });
  });

  // Full conversation for a session
  router.get("/chats/:sessionId", (req, res) => {
    const messages = chatStore.getMessages(req.params.sessionId);
    res.json({ sessionId: req.params.sessionId, messages });
  });

  // Delete a session
  router.delete("/chats/:sessionId", (req, res) => {
    chatStore.deleteSession(req.params.sessionId);
    res.json({ ok: true });
  });

  return router;
}
