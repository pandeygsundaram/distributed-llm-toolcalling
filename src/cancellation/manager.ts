import { logger } from "../logger.js";

interface CancelEntry {
  controller: AbortController;
  sessionId: string;
  createdAt: number;
}

class CancellationManager {
  private entries: Map<string, CancelEntry> = new Map();

  register(requestId: string, sessionId: string): AbortSignal {
    const controller = new AbortController();
    this.entries.set(requestId, { controller, sessionId, createdAt: Date.now() });
    return controller.signal;
  }

  cancel(requestId: string): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    logger.info({ requestId, sessionId: entry.sessionId }, "request.cancelled");
    entry.controller.abort();
    this.entries.delete(requestId);
    return true;
  }

  complete(requestId: string) {
    this.entries.delete(requestId);
  }

  isActive(requestId: string): boolean {
    return this.entries.has(requestId);
  }

  activeCount(): number {
    return this.entries.size;
  }
}

export const cancellationManager = new CancellationManager();
