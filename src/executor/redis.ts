import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  publishToolCall,
  waitForResult,
  CapacityTimeoutError,
  type ToolCallJobResult,
} from "../queue/redis-client.js";
import type { ToolCallRequest, ToolCallResult } from "./local.js";

export class RedisExecutor {
  async execute(req: ToolCallRequest): Promise<ToolCallResult> {
    const log = logger.child({
      requestId: req.requestId,
      sessionId: req.sessionId,
      toolCallId: req.toolCallId,
      tool: req.tool,
      executor: "redis",
    });

    log.info("tool.execution.started");
    const start = Date.now();

    // Subscribe BEFORE publishing — avoids a race where the worker
    // finishes and publishes before we start listening
    const resultPromise = waitForResult(req.toolCallId, config.TOOL_TIMEOUT_MS);

    await publishToolCall({
      toolCallId: req.toolCallId,
      tool: req.tool,
      input: req.input,
      requestId: req.requestId,
      sessionId: req.sessionId,
    });

    log.info("tool.queue.published");

    try {
      const result: ToolCallJobResult = await resultPromise;
      const durationMs = Date.now() - start;
      log.info({ durationMs, pod: result.pod, status: result.status }, "tool.execution.completed");

      return {
        toolCallId: result.toolCallId,
        tool: result.tool,
        output: result.output,
        status: result.status,
        executedIn: "pod",
        pod: result.pod,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;

      if (err instanceof CapacityTimeoutError) {
        log.warn({ durationMs }, "tool.execution.timeout");
        return {
          toolCallId: req.toolCallId,
          tool: req.tool,
          output: JSON.stringify({
            error: {
              code: "sandbox_capacity_timeout",
              message: "No sandbox pod became available within the timeout period.",
            },
          }),
          status: "failed",
          executedIn: "pod",
          durationMs,
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      log.error({ durationMs, error: message }, "tool.execution.failed");
      return {
        toolCallId: req.toolCallId,
        tool: req.tool,
        output: `Error: ${message}`,
        status: "failed",
        executedIn: "pod",
        durationMs,
      };
    }
  }
}
