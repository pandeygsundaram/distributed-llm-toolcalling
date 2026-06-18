import http from "http";
import express from "express";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { initDb } from "./history/db.js";
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
import { getStreamClient, STREAM_KEY, CONSUMER_GROUP } from "./queue/redis-client.js";
import * as k8s from "@kubernetes/client-node";

async function main() {
  await initDb();

  const useRedis = config.USE_REDIS === "true";

  let executor: LocalExecutor | RedisExecutor;
  let leaseManager: LeaseManager | null = null;

  if (useRedis) {
    logger.info("executor: redis (scalable mode)");
    executor = new RedisExecutor();
    leaseManager = new LeaseManager();
  } else {
    logger.info("executor: local (dev mode)");
    executor = new LocalExecutor();
    await (executor as LocalExecutor).init();
  }

  const piClient = new PiClient(executor);

  // K8s autoscaling API for HPA replica count
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV2Api);

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });

  // SSE stream — replaces WebSocket
  app.get("/events", (req, res) => {
    broadcaster.attachClient(res);
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

  // Poll HPA every 2s and broadcast replica count
  let hpaTick = 0;
  const HPA_POLL_EVERY = 10; // every 10 * 200ms = 2s
  let lastHpa = { currentReplicas: 0, desiredReplicas: 0, minReplicas: 8, maxReplicas: 32 };
  setInterval(async () => {
    if (hpaTick++ % HPA_POLL_EVERY !== 0) return;
    try {
      const hpaObj = await autoscalingApi.readNamespacedHorizontalPodAutoscaler({
        name: "sandbox-runner-hpa",
        namespace: config.K8S_NAMESPACE,
      });
      const cur = (hpaObj as any).status?.currentReplicas ?? 0;
      const des = (hpaObj as any).status?.desiredReplicas ?? 0;
      const mn = (hpaObj as any).spec?.minReplicas ?? 8;
      const mx = (hpaObj as any).spec?.maxReplicas ?? 32;
      lastHpa = { currentReplicas: cur, desiredReplicas: des, minReplicas: mn, maxReplicas: mx };
      if (broadcaster.clientCount() > 0) {
        broadcaster.broadcast({ type: "hpa_update", data: lastHpa });
      }
    } catch { /* not critical */ }
  }, 200);

  // Broadcast pod + metrics state every 200ms to connected SSE clients
  setInterval(async () => {
    if (leaseManager) {
      const pods = await leaseManager.listLeaseStates().catch(() => []);
      const inUse = pods.filter((p) => p.lease.status === "leased").length;
      metrics.setPodsInUse(inUse);

      // In Redis mode: real queue depth = pending (in-flight at workers) + lag (undelivered in stream).
      // pending = workers have the message but haven't ACKed (waiting for pod or executing)
      // lag     = messages added after the group's last-delivered-id (no worker has read yet)
      if (useRedis) {
        try {
          const redis = getStreamClient();
          const [pendingRaw, groupInfoRaw] = await Promise.all([
            redis.xpending(STREAM_KEY, CONSUMER_GROUP),
            redis.xinfo("GROUPS", STREAM_KEY),
          ]);
          const pending = Array.isArray(pendingRaw) ? (pendingRaw[0] as number ?? 0) : 0;
          // Parse flat XINFO GROUPS array: [name,v, consumers,v, pending,v, last-delivered-id,v, entries-read,v, lag,v]
          let lag = 0;
          if (Array.isArray(groupInfoRaw)) {
            const flat = groupInfoRaw.flat();
            const lagIdx = flat.indexOf("lag");
            if (lagIdx !== -1) lag = Number(flat[lagIdx + 1]) || 0;
          }
          metrics.setQueueDepth(pending + lag);
        } catch { metrics.setQueueDepth(0); }
      } else {
        metrics.setQueueDepth(leaseManager.queueDepth);
      }

      if (broadcaster.clientCount() > 0) {
        broadcaster.broadcast({ type: "pods_update", data: { pods } });
      }
    }
    if (broadcaster.clientCount() > 0) {
      broadcaster.broadcast({ type: "metrics_update", data: metrics.snapshot() });
    }
  }, 200);

  server.listen(config.PORT, "0.0.0.0", () => {
    logger.info({ port: config.PORT, mode: useRedis ? "redis" : "local" }, "server started");
  });
}

main().catch((err) => {
  logger.error({ err }, "fatal: server failed to start");
  process.exit(1);
});
