import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { logger } from "../logger.js";

type WSEvent =
  | { type: "pods_update"; data: unknown }
  | { type: "execution_update"; data: unknown }
  | { type: "tool_call_update"; data: unknown }
  | { type: "metrics_update"; data: unknown }
  | { type: "queue_update"; data: { depth: number; waiters: number } }
  | { type: "permission_request"; data: unknown };

class Broadcaster {
  private clients = new Set<WebSocket>();
  private wss: WebSocketServer | null = null;

  attach(server: Server) {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      logger.debug({ total: this.clients.size }, "ws.client.connected");

      ws.on("close", () => {
        this.clients.delete(ws);
        logger.debug({ total: this.clients.size }, "ws.client.disconnected");
      });

      ws.on("error", () => this.clients.delete(ws));
    });

    logger.info("ws.broadcaster.ready");
  }

  broadcast(event: WSEvent) {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}

export const broadcaster = new Broadcaster();
