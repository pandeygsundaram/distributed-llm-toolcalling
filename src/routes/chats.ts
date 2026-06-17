import { Router } from "express";
import { chatStore } from "../history/chat-store.js";

export function registerChatHistoryRoutes(): Router {
  const router = Router();

  router.get("/chats", async (_req, res) => {
    const sessions = await chatStore.getSessions();
    res.json({ sessions });
  });

  router.get("/chats/:sessionId", async (req, res) => {
    const messages = await chatStore.getMessages(req.params.sessionId);
    res.json({ sessionId: req.params.sessionId, messages });
  });

  router.delete("/chats/:sessionId", async (req, res) => {
    await chatStore.deleteSession(req.params.sessionId);
    res.json({ ok: true });
  });

  return router;
}
