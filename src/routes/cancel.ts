import { Router } from "express";
import { cancellationManager } from "../cancellation/manager.js";

export function registerCancelRoutes(): Router {
  const router = Router();

  router.post("/cancel/:requestId", (req, res) => {
    const { requestId } = req.params;
    const cancelled = cancellationManager.cancel(requestId);
    if (cancelled) {
      res.json({ ok: true, requestId, message: "request cancelled" });
    } else {
      res.status(404).json({ ok: false, requestId, message: "request not found or already completed" });
    }
  });

  return router;
}
