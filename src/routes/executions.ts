import { Router } from "express";
import { executionStore } from "../history/store.js";

export function registerExecutionRoutes(): Router {
  const router = Router();

  router.get("/executions", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const sessionId = req.query.sessionId as string | undefined;

    const records = sessionId
      ? executionStore.bySession(sessionId)
      : executionStore.list(limit, offset);

    res.json({ total: executionStore.count(), records, executions: records });
  });

  return router;
}
