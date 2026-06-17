import type { Response } from "express";
import { logger } from "../logger.js";

type SSEEvent =
  | { type: "pods_update"; data: unknown }
  | { type: "execution_update"; data: unknown }
  | { type: "tool_call_update"; data: unknown }
  | { type: "metrics_update"; data: unknown }
  | { type: "queue_update"; data: { depth: number; waiters: number } }
  | { type: "permission_request"; data: unknown };

class Broadcaster {
  private clients = new Set<Response>();

  // Called from GET /events — keeps the response open as an SSE stream
  attachClient(res: Response) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    res.flushHeaders();

    this.clients.add(res);
    logger.debug({ total: this.clients.size }, "sse.client.connected");

    // Keep-alive comment every 25s to prevent proxy timeouts
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 25_000);

    res.on("close", () => {
      this.clients.delete(res);
      clearInterval(ping);
      logger.debug({ total: this.clients.size }, "sse.client.disconnected");
    });
  }

  broadcast(event: SSEEvent) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (!client.writableEnded) {
        client.write(payload);
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}

export const broadcaster = new Broadcaster();
