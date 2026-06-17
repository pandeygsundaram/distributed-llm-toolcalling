import { Router } from "express";
import { metrics, register } from "../metrics/index.js";

export function registerMetricsRoutes(): Router {
  const router = Router();

  // Prometheus scraping endpoint — used by prometheus-adapter for HPA
  router.get("/metrics/prometheus", async (_req, res) => {
    res.setHeader("Content-Type", register.contentType);
    res.send(await register.metrics());
  });

  // JSON snapshot for the dashboard (served via SSE metrics_update every 2s, but also queryable directly)
  router.get("/metrics", (_req, res) => {
    res.json(metrics.snapshot());
  });

  return router;
}
