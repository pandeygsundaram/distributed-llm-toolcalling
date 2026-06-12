import type { Router, Request, Response } from "express";
import { Router as createRouter } from "express";
import type { LeaseManager } from "../sandbox/lease-manager.js";

export function registerHealthRoutes(leaseManager: LeaseManager | null): Router {
  const router = createRouter();

  router.get("/health", async (_req: Request, res: Response) => {
    if (!leaseManager) {
      res.json({ ok: true, phase: "1-local", kubernetes: "not-connected", sandboxPodsReady: 0 });
      return;
    }

    try {
      const states = await leaseManager.listLeaseStates();
      const ready = states.filter((s) => s.lease.status !== "unknown").length;
      res.json({ ok: true, phase: "2-redis", kubernetes: "connected", sandboxPodsReady: ready });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ ok: false, phase: "2-redis", kubernetes: "error", error: msg });
    }
  });

  return router;
}
