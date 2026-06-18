import { AsyncLocalStorage } from "async_hooks";

const SYSTEM_PROMPT = `You are a sandbox execution agent. You run commands inside isolated Kubernetes pods on behalf of the user.

## RULE: Always call a tool when the user asks to run, execute, check, list, inspect, or see anything in the sandbox. Never describe what you would do — just do it immediately.

Examples:
- "run ls" → call shell_run(ls) NOW
- "run pwd" → call shell_run(pwd) NOW
- "what pod am I on?" → call env_inspect() NOW
- "show me the files" → call shell_run(ls) NOW
- "check node version" → call shell_run(node --version) NOW

## Tools

- **shell_run** — run a shell command in the pod. Allowed: pwd, ls, cat, whoami, node, sleep.
- **fs_read** — read a file from the pod by path.
- **fs_write** — write content to a file in the pod. ALWAYS requires human approval — the user will see a preview modal and must approve before the write happens. If rejected, do not retry without asking the user.
- **math_compute** — run a math operation inside the pod (add, subtract, multiply, divide, modulo, power, sqrt, factorial, fibonacci, is_prime, gcd). The computation executes in the pod via Node.js. Use this for any arithmetic the user asks for.
- **env_inspect** — get hostname, pod name, namespace, user, working directory.

## After a tool call

Show the raw output in a fenced code block, then one short sentence interpreting it.

## Capacity timeouts

If a tool call fails because all pods are busy (capacity timeout), tell the user clearly and suggest they try again in a moment.

## Never

- Never ask for permission before calling a tool when the user clearly wants something run.
- Never describe what you would do instead of doing it.
- Never respond without calling a tool if the user asked to run or inspect something.`;

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { approvalManager } from "../approval/manager.js";
import { broadcaster } from "../ws/broadcaster.js";
import type { ToolCallRequest, ToolCallResult } from "../executor/local.js";

export interface Executor {
  execute(req: ToolCallRequest): Promise<ToolCallResult>;
}

export interface ChatInput {
  sessionId: string;
  message: string;
  requestId: string;
  signal?: AbortSignal;
}

export interface ChatResult {
  sessionId: string;
  message: string;
  toolCalls: ToolCallSummary[];
}

export interface ToolCallSummary {
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  status: "completed" | "failed";
  executedIn: "local" | "pod";
  pod?: string;
  durationMs: number;
  queuePosition?: number;
  queueWaitMs?: number;
}

function recordToolCall(
  summaries: ToolCallSummary[],
  summary: ToolCallSummary,
  ctx: { sessionId: string; requestId: string }
) {
  summaries.push(summary);
  broadcaster.broadcast({
    type: "tool_call_update",
    data: { ...summary, sessionId: ctx.sessionId, requestId: ctx.requestId },
  });
}

// Thread request context into tool execute() via AsyncLocalStorage
export const requestCtx = new AsyncLocalStorage<{
  requestId: string;
  sessionId: string;
  signal?: AbortSignal;
}>();

export class PiClient {
  private sessions = new Map<string, AgentSession>();
  private readonly executor: Executor;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;

  constructor(executor: Executor) {
    this.executor = executor;
    this.authStorage = AuthStorage.create("/tmp/sendai-pi-auth.json");
    this.authStorage.setRuntimeApiKey("anthropic", config.ANTHROPIC_API_KEY);
    this.modelRegistry = ModelRegistry.inMemory(this.authStorage);
  }

  async runChat(input: ChatInput): Promise<ChatResult> {
    const log = logger.child({ requestId: input.requestId, sessionId: input.sessionId });
    log.info({ message: input.message }, "chat.request.started");

    const toolCallSummaries: ToolCallSummary[] = [];

    const session = await this.getOrCreateSession(input.sessionId, toolCallSummaries);

    return new Promise<ChatResult>((resolve, reject) => {
      let accumulated = "";

      // Listen for completion
      const unsub = session.subscribe((event) => {
        // Accumulate text deltas — the text lives at event.assistantMessageEvent.delta
        if (event.type === "message_update") {
          const mu = event as unknown as {
            assistantMessageEvent?: { type?: string; delta?: string };
          };
          const ame = mu.assistantMessageEvent;
          if (ame?.type === "text_delta" && typeof ame.delta === "string") {
            accumulated += ame.delta;
          }
        }

        if (event.type === "agent_end") {
          unsub();
          // Fallback: read from agent_end.messages (role:"assistant") if streaming missed it
          if (!accumulated) {
            const msgs = (event as unknown as {
              messages?: Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>
            }).messages ?? [];
            const last = [...msgs].reverse().find(
              (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "text")
            );
            accumulated = last?.content?.find((c) => c.type === "text")?.text ?? "(no response)";
          }
          log.info({ toolCallCount: toolCallSummaries.length }, "chat.request.completed");
          resolve({ sessionId: input.sessionId, message: accumulated, toolCalls: [...toolCallSummaries] });
        }
      });

      // Abort support
      if (input.signal) {
        input.signal.addEventListener("abort", () => {
          unsub();
          session.abort().catch(() => {});
          reject(new Error("request cancelled"));
        });
      }

      // Run inside AsyncLocalStorage context so tools can read requestId/sessionId
      requestCtx.run(
        { requestId: input.requestId, sessionId: input.sessionId, signal: input.signal },
        () => {
          session.prompt(input.message).catch((err) => {
            unsub();
            reject(err);
          });
        }
      );
    });
  }

  private async getOrCreateSession(
    sessionId: string,
    toolCallSummaries: ToolCallSummary[]
  ): Promise<AgentSession> {
    if (this.sessions.has(sessionId)) {
      // Wait for any in-progress prompt to finish before reusing
      const existing = this.sessions.get(sessionId)!;
      await existing.agent.waitForIdle();
      return existing;
    }

    const model = getModel("anthropic", "claude-sonnet-4-6");
    if (!model) throw new Error("Claude model not found in Pi registry");

    const executor = this.executor;

    const shellRunTool = defineTool({
      name: "shell_run",
      label: "Shell Run",
      description: "Run an allowlisted shell command in the sandbox. Allowed: pwd, ls, cat, whoami, node --version, sleep <seconds>.",
      parameters: Type.Object({
        command: Type.Union([
          Type.Literal("pwd"),
          Type.Literal("ls"),
          Type.Literal("cat"),
          Type.Literal("whoami"),
          Type.Literal("node"),
          Type.Literal("sleep"),
        ], { description: "The command to run" }),
        args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments" })),
      }),
      execute: async (toolCallId, params) => {
        const ctx = requestCtx.getStore()!;
        const result = await executor.execute({
          toolCallId,
          tool: "shell_run",
          input: params as Record<string, unknown>,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
        });
        recordToolCall(toolCallSummaries, {
          toolCallId,
          tool: "shell_run",
          input: params as Record<string, unknown>,
          output: result.output,
          status: result.status,
          executedIn: result.executedIn,
          pod: result.pod,
          durationMs: result.durationMs,
          queuePosition: result.queuePosition,
          queueWaitMs: result.queueWaitMs,
        }, ctx);
        return {
          content: [{ type: "text" as const, text: result.output }],
          details: { pod: result.pod, durationMs: result.durationMs },
        };
      },
    });

    const fsReadTool = defineTool({
      name: "fs_read",
      label: "Read File",
      description: "Read a file from the sandbox directory. Only relative paths within the sandbox are allowed.",
      parameters: Type.Object({
        filePath: Type.String({ description: "Relative path to the file within the sandbox" }),
      }),
      execute: async (toolCallId, params) => {
        const ctx = requestCtx.getStore()!;
        const result = await executor.execute({
          toolCallId,
          tool: "fs_read",
          input: params as Record<string, unknown>,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
        });
        recordToolCall(toolCallSummaries, {
          toolCallId,
          tool: "fs_read",
          input: params as Record<string, unknown>,
          output: result.output,
          status: result.status,
          executedIn: result.executedIn,
          pod: result.pod,
          durationMs: result.durationMs,
          queuePosition: result.queuePosition,
          queueWaitMs: result.queueWaitMs,
        }, ctx);
        return {
          content: [{ type: "text" as const, text: result.output }],
          details: { pod: result.pod, durationMs: result.durationMs },
        };
      },
    });

    const fsWriteTool = defineTool({
      name: "fs_write",
      label: "Write File (requires approval)",
      description: "Write content to a file in the sandbox. ALWAYS requires human approval before executing — the user will see a preview and must approve or reject.",
      parameters: Type.Object({
        filePath: Type.String({ description: "Relative path within the sandbox to write to" }),
        content: Type.String({ description: "Content to write into the file" }),
      }),
      execute: async (toolCallId, params) => {
        const ctx = requestCtx.getStore()!;
        const approval = approvalManager.create({
          toolCallId,
          tool: "fs_write",
          filePath: params.filePath,
          content: params.content,
          sessionId: ctx.sessionId,
        });

        // Send permission request to frontend — LLM blocks here until user responds
        broadcaster.broadcast({ type: "permission_request", data: approval });

        const approved = await approvalManager.waitForResponse(approval.approvalId, 60_000);

        if (!approved) {
          const rejMsg = "Write rejected by user. Do not retry without asking.";
          recordToolCall(toolCallSummaries, {
            toolCallId,
            tool: "fs_write",
            input: params as Record<string, unknown>,
            output: rejMsg,
            status: "failed",
            executedIn: "pod",
            durationMs: 0,
          }, ctx);
          return {
            content: [{ type: "text" as const, text: rejMsg }],
            details: { pod: undefined, durationMs: 0 },
          };
        }

        const result = await executor.execute({
          toolCallId,
          tool: "fs_write",
          input: params as Record<string, unknown>,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
        });

        recordToolCall(toolCallSummaries, {
          toolCallId,
          tool: "fs_write",
          input: params as Record<string, unknown>,
          output: result.output || `Written to ${params.filePath}`,
          status: result.status,
          executedIn: result.executedIn,
          pod: result.pod,
          durationMs: result.durationMs,
        }, ctx);

        return {
          content: [{ type: "text" as const, text: result.output || `Written to ${params.filePath}` }],
          details: { pod: result.pod, durationMs: result.durationMs },
        };
      },
    });

    const mathComputeTool = defineTool({
      name: "math_compute",
      label: "Math Compute (runs in pod)",
      description: "Execute a math operation inside the pod using Node.js. Supports: add, subtract, multiply, divide, modulo, power, sqrt, factorial, fibonacci, is_prime, gcd. Large results (factorial, fibonacci) use BigInt and return exact integers.",
      parameters: Type.Object({
        operation: Type.Union([
          Type.Literal("add"),
          Type.Literal("subtract"),
          Type.Literal("multiply"),
          Type.Literal("divide"),
          Type.Literal("modulo"),
          Type.Literal("power"),
          Type.Literal("sqrt"),
          Type.Literal("factorial"),
          Type.Literal("fibonacci"),
          Type.Literal("is_prime"),
          Type.Literal("gcd"),
        ], { description: "The math operation to perform" }),
        a: Type.Optional(Type.Number({ description: "First operand (or the sole operand for unary ops like sqrt, factorial, fibonacci, is_prime)" })),
        b: Type.Optional(Type.Number({ description: "Second operand (required for binary ops: add, subtract, multiply, divide, modulo, power, gcd)" })),
      }),
      execute: async (toolCallId, params) => {
        const ctx = requestCtx.getStore()!;
        const result = await executor.execute({
          toolCallId,
          tool: "math_compute",
          input: params as Record<string, unknown>,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
        });
        recordToolCall(toolCallSummaries, {
          toolCallId,
          tool: "math_compute",
          input: params as Record<string, unknown>,
          output: result.output,
          status: result.status,
          executedIn: result.executedIn,
          pod: result.pod,
          durationMs: result.durationMs,
          queuePosition: result.queuePosition,
          queueWaitMs: result.queueWaitMs,
        }, ctx);
        return {
          content: [{ type: "text" as const, text: result.output }],
          details: { pod: result.pod, durationMs: result.durationMs },
        };
      },
    });

    const envInspectTool = defineTool({
      name: "env_inspect",
      label: "Inspect Environment",
      description: "Returns runtime info: hostname, user, working directory, node version, pod name and namespace.",
      parameters: Type.Object({}),
      execute: async (toolCallId) => {
        const ctx = requestCtx.getStore()!;
        const result = await executor.execute({
          toolCallId,
          tool: "env_inspect",
          input: {},
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
        });
        recordToolCall(toolCallSummaries, {
          toolCallId,
          tool: "env_inspect",
          input: {},
          output: result.output,
          status: result.status,
          executedIn: result.executedIn,
          pod: result.pod,
          durationMs: result.durationMs,
          queuePosition: result.queuePosition,
          queueWaitMs: result.queueWaitMs,
        }, ctx);
        return {
          content: [{ type: "text" as const, text: result.output }],
          details: { pod: result.pod, durationMs: result.durationMs },
        };
      },
    });

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });

    const resourceLoader = new DefaultResourceLoader({
      cwd: "/tmp/sendai-pi-agent",
      agentDir: "/tmp/sendai-pi-agent",
      systemPromptOverride: () => SYSTEM_PROMPT,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      noTools: "builtin",
      customTools: [shellRunTool, fsReadTool, fsWriteTool, mathComputeTool, envInspectTool],
      resourceLoader,
    });

    this.sessions.set(sessionId, session);
    logger.info({ sessionId }, "pi.session.created");

    return session;
  }

  disposeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  activeSessions(): number {
    return this.sessions.size;
  }
}
