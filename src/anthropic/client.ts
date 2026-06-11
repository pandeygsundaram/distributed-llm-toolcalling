import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlock } from "@anthropic-ai/sdk/resources/messages.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { toolDefinitions } from "../tools/registry.js";
import type { ToolCallRequest, ToolCallResult } from "../executor/local.js";
import { v4 as uuid } from "uuid";

// Any executor that can run a tool call (local or redis-backed)
export interface Executor {
  execute(req: ToolCallRequest): Promise<ToolCallResult>;
}

export interface ChatInput {
  sessionId: string;
  message: string;
  requestId: string;
}

export interface ChatResult {
  sessionId: string;
  message: string;
  toolCalls: ToolCallSummary[];
}

export interface ToolCallSummary {
  toolCallId: string;
  tool: string;
  status: "completed" | "failed";
  executedIn: "local" | "pod";
  pod?: string;
  durationMs: number;
}

export class AnthropicClient {
  private readonly client: Anthropic;
  private readonly executor: Executor;

  constructor(executor: Executor) {
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    this.executor = executor;
  }

  async runChat(input: ChatInput): Promise<ChatResult> {
    const log = logger.child({ requestId: input.requestId, sessionId: input.sessionId });
    log.info({ message: input.message }, "chat.request.started");

    const messages: MessageParam[] = [{ role: "user", content: input.message }];
    const toolCallSummaries: ToolCallSummary[] = [];

    // Agentic loop — keeps running until stop_reason is "end_turn"
    while (true) {
      const response = await this.client.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 4096,
        tools: toolDefinitions,
        messages,
      });

      log.debug({ stopReason: response.stop_reason, contentBlocks: response.content.length }, "anthropic.response");

      if (response.stop_reason === "tool_use") {
        // Append the assistant turn (contains tool_use blocks)
        messages.push({ role: "assistant", content: response.content });

        // Execute every tool_use block in parallel
        const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

        const results: ToolCallResult[] = await Promise.all(
          toolUseBlocks.map((block) =>
            this.executor.execute({
              toolCallId: block.id,
              tool: block.name,
              input: block.input as Record<string, unknown>,
              requestId: input.requestId,
              sessionId: input.sessionId,
            })
          )
        );

        // Collect summaries
        for (const r of results) {
          toolCallSummaries.push({
            toolCallId: r.toolCallId,
            tool: r.tool,
            status: r.status,
            executedIn: r.executedIn,
            pod: r.pod,
            durationMs: r.durationMs,
          });
        }

        // Append tool results as a user turn
        messages.push({
          role: "user",
          content: results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.toolCallId,
            content: r.output,
            is_error: r.status === "failed",
          })),
        });

        continue;
      }

      // stop_reason === "end_turn" — extract final text
      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      const finalMessage = textBlock?.text ?? "(no response)";

      log.info({ toolCallCount: toolCallSummaries.length }, "chat.request.completed");

      return {
        sessionId: input.sessionId,
        message: finalMessage,
        toolCalls: toolCallSummaries,
      };
    }
  }
}
