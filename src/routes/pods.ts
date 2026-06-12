import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import type { LeaseManager } from "../sandbox/lease-manager.js";

export function registerPodsRoutes(leaseManager: LeaseManager | null): Router {
  const router = createRouter();

  router.get("/pods", async (_req: Request, res: Response) => {
    if (!leaseManager) {
      res.json({ phase: "1-local", pods: [], note: "Pod pool not available in Phase 1." });
      return;
    }

    const [pods, queue] = await Promise.all([
      leaseManager.listLeaseStates(),
      Promise.resolve(leaseManager.queueInfo()),
    ]);
    res.json({ pods, queue });
  });

  return router;
}
