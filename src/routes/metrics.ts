import { Router } from "express";
import { metrics } from "../metrics/index.js";

export function registerMetricsRoutes(): Router {
  const router = Router();

  router.get("/metrics", (_req, res) => {
    res.json(metrics.snapshot());
  });

  return router;
}
