import type { FastifyInstance } from "fastify";
import type { LeaseManager } from "../sandbox/lease-manager.js";

export function registerHealthRoutes(app: FastifyInstance, leaseManager: LeaseManager | null) {
  app.get("/health", async (_req, reply) => {
    if (!leaseManager) {
      return reply.send({ ok: true, phase: "1-local", kubernetes: "not-connected", sandboxPodsReady: 0 });
    }

    try {
      const states = await leaseManager.listLeaseStates();
      const ready = states.filter((s) => s.lease.status !== "unknown").length;
      return reply.send({ ok: true, phase: "2-redis", kubernetes: "connected", sandboxPodsReady: ready });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(503).send({ ok: false, phase: "2-redis", kubernetes: "error", error: msg });
    }
  });
}
