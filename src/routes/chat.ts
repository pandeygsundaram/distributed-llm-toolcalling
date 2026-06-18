import { Router, type Request } from "express";
import { v4 as uuid } from "uuid";
import type { PiClient } from "../pi/client.js";
import { cancellationManager } from "../cancellation/manager.js";
import { executionStore } from "../history/store.js";
import { chatStore } from "../history/chat-store.js";
import { metrics } from "../metrics/index.js";
import { broadcaster } from "../ws/broadcaster.js";
import { logger } from "../logger.js";
import { getLockClient, SESSION_INFLIGHT_KEY } from "../queue/redis-client.js";
import { config } from "../config.js";

// Simple sliding-window rate limiter: 20 requests per 60s per IP
const RATE_LIMIT = 10_000;
const RATE_WINDOW_MS = 60_000;
const rateCounts = new Map<string, number[]>();

function getClientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.ip ?? "unknown";
}

function isRateLimited(req: Request): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const hits = (rateCounts.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateCounts.set(ip, hits);
  return hits.length > RATE_LIMIT;
}

export function registerChatRoutes(client: PiClient): Router {
  const router = Router();

  router.post("/chat", async (req, res) => {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      res.status(400).json({ error: "sessionId and message are required" });
      return;
    }

    if (isRateLimited(req)) {
      res.status(429).json({ error: "rate limit exceeded", retryAfterMs: RATE_WINDOW_MS });
      return;
    }

    // Per-session concurrency limit — prevents one session from starving the pod pool
    const lockClient = getLockClient();
    const inflightKey = SESSION_INFLIGHT_KEY(sessionId);
    const inflight = await lockClient.incr(inflightKey);
    await lockClient.expire(inflightKey, 300); // 5-min safety TTL

    if (inflight > config.MAX_SESSION_INFLIGHT) {
      await lockClient.decr(inflightKey);
      res.status(429).json({
        error: "too many concurrent requests for this session",
        limit: config.MAX_SESSION_INFLIGHT,
      });
      return;
    }

    const requestId = uuid();
    const signal = cancellationManager.register(requestId, sessionId);
    const start = Date.now();

    await chatStore.addMessage({
      id: uuid(),
      sessionId,
      role: "user",
      content: message,
      createdAt: new Date().toISOString(),
    });

    try {
      const result = await client.runChat({ sessionId, message, requestId, signal });

      for (const tc of result.toolCalls) {
        const record = {
          id: uuid(),
          requestId,
          sessionId,
          toolCallId: tc.toolCallId,
          tool: tc.tool,
          input: tc.input,
          output: tc.output,
          pod: tc.pod ?? "local",
          status: tc.status,
          startedAt: new Date(start).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: tc.durationMs,
        };
        await executionStore.add(record);
        metrics.recordToolExecution(tc.tool, tc.durationMs, tc.status);
        broadcaster.broadcast({ type: "execution_update", data: record });
      }

      await chatStore.addMessage({
        id: uuid(),
        sessionId,
        role: "assistant",
        content: result.message,
        toolCalls: JSON.stringify(result.toolCalls),
        createdAt: new Date().toISOString(),
      });

      res.json({ requestId, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "request cancelled") {
        res.status(499).json({ error: "request cancelled", requestId });
      } else {
        logger.error({ err, requestId }, "chat.error");
        res.status(500).json({ error: "internal server error", requestId });
      }
    } finally {
      cancellationManager.complete(requestId);
      await lockClient.decr(inflightKey).catch(() => {});
    }
  });

  return router;
}
