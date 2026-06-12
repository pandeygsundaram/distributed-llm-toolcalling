import { randomUUID } from "crypto";
import { logger } from "../logger.js";

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  tool: string;
  filePath: string;
  content: string;
  sessionId: string;
  createdAt: string;
}

class ApprovalManager {
  private pending = new Map<string, (approved: boolean) => void>();

  create(params: Omit<PendingApproval, "approvalId" | "createdAt">): PendingApproval {
    return {
      approvalId: randomUUID(),
      createdAt: new Date().toISOString(),
      ...params,
    };
  }

  waitForResponse(approvalId: string, timeoutMs = 60_000): Promise<boolean> {
    return new Promise((resolve) => {
      this.pending.set(approvalId, resolve);

      setTimeout(() => {
        if (this.pending.has(approvalId)) {
          this.pending.delete(approvalId);
          logger.warn({ approvalId }, "approval.timeout — auto-rejecting");
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  respond(approvalId: string, approved: boolean): boolean {
    const resolve = this.pending.get(approvalId);
    if (!resolve) return false;
    this.pending.delete(approvalId);
    logger.info({ approvalId, approved }, "approval.responded");
    resolve(approved);
    return true;
  }

  hasPending(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }
}

export const approvalManager = new ApprovalManager();
