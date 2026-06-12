import fs from "fs/promises";
import path from "path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { shellRun } from "../tools/shell-run.js";
import { fsRead } from "../tools/fs-read.js";
import { envInspect } from "../tools/env-inspect.js";
import { TOOL_NAMES, type ToolName } from "../tools/registry.js";

export interface ToolCallRequest {
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  requestId: string;
  sessionId: string;
}

export interface ToolCallResult {
  toolCallId: string;
  tool: string;
  output: string;
  status: "completed" | "failed";
  executedIn: "local" | "pod";
  pod?: string;
  durationMs: number;
  queuePosition?: number;
  queueWaitMs?: number;
}

export class LocalExecutor {
  private readonly sandboxDir: string;

  constructor(sandboxDir = config.SANDBOX_DIR) {
    this.sandboxDir = path.resolve(process.cwd(), sandboxDir);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.sandboxDir, { recursive: true });
    logger.info({ sandboxDir: this.sandboxDir }, "local executor: sandbox directory ready");
  }

  async execute(req: ToolCallRequest): Promise<ToolCallResult> {
    const start = Date.now();
    const log = logger.child({
      requestId: req.requestId,
      sessionId: req.sessionId,
      toolCallId: req.toolCallId,
      tool: req.tool,
      executor: "local",
    });

    log.info("tool.execution.started");

    try {
      const output = await this.dispatch(req.tool as ToolName, req.input);
      const durationMs = Date.now() - start;

      log.info({ durationMs }, "tool.execution.completed");

      return {
        toolCallId: req.toolCallId,
        tool: req.tool,
        output: typeof output === "string" ? output : JSON.stringify(output, null, 2),
        status: "completed",
        executedIn: "local",
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      log.error({ durationMs, error: message }, "tool.execution.failed");

      return {
        toolCallId: req.toolCallId,
        tool: req.tool,
        output: `Error: ${message}`,
        status: "failed",
        executedIn: "local",
        durationMs,
      };
    }
  }

  private async dispatch(tool: ToolName, input: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case TOOL_NAMES.SHELL_RUN:
        return shellRun(input as unknown as Parameters<typeof shellRun>[0], this.sandboxDir);

      case TOOL_NAMES.FS_READ:
        return fsRead(input as unknown as Parameters<typeof fsRead>[0], this.sandboxDir);

      case TOOL_NAMES.ENV_INSPECT:
        return envInspect(this.sandboxDir);

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }
}
