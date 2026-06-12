import http from "http";
import express from "express";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { LocalExecutor } from "./executor/local.js";
import { RedisExecutor } from "./executor/redis.js";
import { PiClient } from "./pi/client.js";
import { LeaseManager } from "./sandbox/lease-manager.js";
import { broadcaster } from "./ws/broadcaster.js";
import { metrics } from "./metrics/index.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPodsRoutes } from "./routes/pods.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerExecutionRoutes } from "./routes/executions.js";
import { registerCancelRoutes } from "./routes/cancel.js";
import { registerChatHistoryRoutes } from "./routes/chats.js";
import { registerApprovalRoutes } from "./routes/approve.js";

async function main() {
  const useRedis = config.USE_REDIS === "true";

  let executor: LocalExecutor | RedisExecutor;
  let leaseManager: LeaseManager | null = null;

  if (useRedis) {
    logger.info("executor: redis (phase 2)");
    executor = new RedisExecutor();
    leaseManager = new LeaseManager();
  } else {
    logger.info("executor: local (phase 1)");
    executor = new LocalExecutor();
    await (executor as LocalExecutor).init();
  }

  const piClient = new PiClient(executor);

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });

  app.use(registerHealthRoutes(leaseManager));
  app.use(registerPodsRoutes(leaseManager));
  app.use(registerChatRoutes(piClient));
  app.use(registerMetricsRoutes());
  app.use(registerExecutionRoutes());
  app.use(registerCancelRoutes());
  app.use(registerChatHistoryRoutes());
  app.use(registerApprovalRoutes());

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal server error" });
  });

  const server = http.createServer(app);
  broadcaster.attach(server);

  // Broadcast pod + metrics state every 2s to connected WebSocket clients
  setInterval(async () => {
    if (broadcaster.clientCount() === 0) return;
    if (leaseManager) {
      const pods = await leaseManager.listLeaseStates().catch(() => []);
      const inUse = pods.filter(p => p.lease.status === "leased").length;
      metrics.setPodsInUse(inUse);
      broadcaster.broadcast({ type: "pods_update", data: { pods } });
    }
    broadcaster.broadcast({ type: "metrics_update", data: metrics.snapshot() });
  }, 2000);

  server.listen(config.PORT, "0.0.0.0", () => {
    logger.info({ port: config.PORT, mode: useRedis ? "redis" : "local" }, "server started");
  });
}

main().catch((err) => {
  logger.error({ err }, "fatal: server failed to start");
  process.exit(1);
});
