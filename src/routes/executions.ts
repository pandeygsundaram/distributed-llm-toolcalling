import { Router } from "express";
import { executionStore } from "../history/store.js";
import { getStreamClient, DLQ_KEY } from "../queue/redis-client.js";

export function registerExecutionRoutes(): Router {
  const router = Router();

  router.get("/executions", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const sessionId = req.query.sessionId as string | undefined;

    const [records, total] = await Promise.all([
      sessionId ? executionStore.bySession(sessionId) : executionStore.list(limit, offset),
      executionStore.count(),
    ]);

    res.json({ total, records, executions: records });
  });

  // Dead letter queue inspection endpoint
  router.get("/dlq", async (_req, res) => {
    const client = getStreamClient();
    const entries = await client.xrange(DLQ_KEY, "-", "+", "COUNT", 100);
    const items = entries.map(([id, fields]) => {
      const map: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];
      return { id, ...map };
    });
    res.json({ count: items.length, items });
  });

  return router;
}
