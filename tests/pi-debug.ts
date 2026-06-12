/**
 * Standalone Pi SDK debug script.
 * Run: npx tsx tests/pi-debug.ts
 *
 * Tests:
 *   1. Simple "yo" message — no tools, just see what Pi returns
 *   2. Tool call — shell_run ls, see if output comes back
 */

import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import "dotenv/config";

const API_KEY = process.env.ANTHROPIC_API_KEY!;
if (!API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

// ─── Auth ────────────────────────────────────────────────────────────────────
const authStorage = AuthStorage.create("/tmp/pi-debug-auth.json");
authStorage.setRuntimeApiKey("anthropic", API_KEY);
const modelRegistry = ModelRegistry.inMemory(authStorage);

const model = getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("model not found");

// ─── Helper: collect all events and print them ───────────────────────────────
function listenAndDump(session: Awaited<ReturnType<typeof createAgentSession>>["session"], label: string) {
  return new Promise<string>((resolve) => {
    let accumulated = "";

    const unsub = session.subscribe((event) => {
      // Print every event so we can see the shape
      console.log(`[${label}] event.type =`, event.type);
      if (event.type === "message_update") {
        const mu = event as unknown as { assistantMessageEvent?: { type?: string; delta?: string } };
        const ame = mu.assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          accumulated += ame.delta;
        }
      }
      if (event.type === "agent_end") {
        unsub();
        // Fallback from messages if streaming gave nothing
        if (!accumulated) {
          const msgs = (event as unknown as { messages?: Array<{ role?: string; content?: Array<{ type: string; text?: string }> }> }).messages ?? [];
          const last = [...msgs].reverse().find(m => m.role === "assistant" && m.content?.some(c => c.type === "text"));
          accumulated = last?.content?.find(c => c.type === "text")?.text ?? "(empty)";
        }
        console.log(`\n[${label}] FINAL: "${accumulated}"`);
        resolve(accumulated);
      }
    });
  });
}

// ─── Test 1: simple message, no tools ────────────────────────────────────────
async function testSimple() {
  console.log("\n=== TEST 1: simple 'yo' message ===");

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    noTools: "builtin",
    customTools: [],
  });

  const resultPromise = listenAndDump(session, "simple");
  await session.prompt("yo, reply in exactly 5 words");
  const text = await resultPromise;
  console.log(`[simple] FINAL: "${text}"\n`);
}

// ─── Test 2: shell_run tool call ─────────────────────────────────────────────
async function testToolCall() {
  console.log("\n=== TEST 2: tool call (shell_run ls) ===");

  let toolFired = false;

  const shellRunTool = defineTool({
    name: "shell_run",
    label: "Shell Run",
    description: "Run ls in the sandbox.",
    parameters: Type.Object({
      command: Type.String({ description: "Command to run" }),
    }),
    execute: async (_toolCallId, params) => {
      toolFired = true;
      console.log("[tool] shell_run called with:", params);
      // Fake result — no actual pod needed for this debug test
      return {
        content: [{ type: "text" as const, text: "file1.txt  file2.txt  README.md" }],
      };
    },
  });

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    noTools: "builtin",
    customTools: [shellRunTool],
  });

  const resultPromise = listenAndDump(session, "tool");
  await session.prompt("run shell_run with command ls and tell me what files you see");
  const text = await resultPromise;
  console.log(`[tool] toolFired: ${toolFired}`);
  console.log(`[tool] FINAL: "${text}"\n`);
}

// ─── Run both ─────────────────────────────────────────────────────────────────
(async () => {
  await testSimple();
  await testToolCall();
  process.exit(0);
})().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
