import type { FastifyInstance } from "fastify";
import type { LeaseManager } from "../sandbox/lease-manager.js";

export function registerPodsRoutes(app: FastifyInstance, leaseManager: LeaseManager | null) {
  app.get("/pods", async (_req, reply) => {
    if (!leaseManager) {
      return reply.send({
        phase: "1-local",
        pods: [],
        note: "Pod pool not available in Phase 1.",
      });
    }

    const pods = await leaseManager.listLeaseStates();
    return reply.send({ pods });
  });
}
