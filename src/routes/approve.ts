import { Router } from "express";
import { approvalManager } from "../approval/manager.js";

export function registerApprovalRoutes(): Router {
  const router = Router();

  router.post("/approve/:approvalId", (req, res) => {
    const { approvalId } = req.params;
    const { approved } = req.body as { approved: boolean };

    if (typeof approved !== "boolean") {
      res.status(400).json({ error: "approved must be a boolean" });
      return;
    }

    const ok = approvalManager.respond(approvalId, approved);
    if (!ok) {
      res.status(404).json({ error: "no pending approval with that id" });
      return;
    }

    res.json({ ok: true, approved });
  });

  return router;
}
