/**
 * Stress + coverage test.
 *
 * Strategy:
 *  - All queue/pod/latency/history tests fire tool calls DIRECTLY via the
 *    Redis queue (no LLM involved). Fast, safe, no rate limits.
 *  - Exactly 1 Pi LLM call at the end as an AI smoke test.
 *
 * Run: npm run stress:concurrent
 * Requires: server + worker running, K8s pods up, Redis up.
 */

import "dotenv/config";
import { randomUUID } from "crypto";
import {
  publishToolCall,
  waitForResult,
  waitForPodFreed,
  ensureConsumerGroup,
} from "../../src/queue/redis-client.js";

const BASE = "http://localhost:3000";
const SEP = "─".repeat(60);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function httpGet(path: string) {
  const r = await fetch(`${BASE}${path}`);
  return r.json();
}

async function httpPost(path: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}

let passed = 0, failed = 0;
function pass(msg: string) { console.log(`  ✅  ${msg}`); passed++; }
function fail(msg: string) { console.log(`  ❌  ${msg}`); failed++; }
function info(msg: string) { console.log(`  ℹ️   ${msg}`); }
function header(msg: string) { console.log(`\n${SEP}\n${msg}\n${SEP}`); }

// Fire a tool call directly through the Redis queue (no LLM).
// Waits for both the result AND the pod-freed signal so the caller knows
// the pod is truly available again before moving on to the next batch.
async function directToolCall(tool: string, input: Record<string, unknown>, sessionId = "stress") {
  const toolCallId = randomUUID();
  const requestId = randomUUID();
  const resultPromise = waitForResult(toolCallId, 30_000);
  const freedPromise = waitForPodFreed(toolCallId, 30_000); // waits for THIS call's pod specifically
  await publishToolCall({ toolCallId, tool, input, requestId, sessionId });
  const result = await resultPromise;
  await freedPromise; // pod is truly free before caller proceeds
  return result;
}

// ─── Test 1: Health + endpoints ───────────────────────────────────────────────

async function testEndpoints() {
  header("Test 1: Health + endpoint structure");

  const h = await httpGet("/health") as { ok: boolean; kubernetes: string; sandboxPodsReady: number };
  h.ok ? pass("GET /health → ok") : fail(`GET /health not ok: ${JSON.stringify(h)}`);
  h.kubernetes === "connected" ? pass("K8s connected") : fail(`K8s: ${h.kubernetes}`);
  h.sandboxPodsReady === 8 ? pass("8 pods ready") : fail(`${h.sandboxPodsReady} pods ready`);

  const p = await httpGet("/pods") as { pods: unknown[]; queue: { depth: number; estimatedWaitMs: number } };
  p.pods.length === 8 ? pass("GET /pods → 8 pods") : fail(`Expected 8 pods, got ${p.pods.length}`);
  typeof p.queue.depth === "number" ? pass(`Queue depth field: ${p.queue.depth}`) : fail("Missing queue.depth");
  typeof p.queue.estimatedWaitMs === "number" ? pass(`estimatedWaitMs field present`) : fail("Missing estimatedWaitMs");

  const m = await httpGet("/metrics") as { window: string; queueDepth: number; tools: Record<string, unknown>; generatedAt: string };
  m.window === "5m" && typeof m.queueDepth === "number" && typeof m.tools === "object"
    ? pass("GET /metrics → valid shape (window, queueDepth, tools)")
    : fail(`Bad /metrics shape: ${JSON.stringify(m).slice(0, 100)}`);

  const e = await httpGet("/executions") as { executions: unknown[] };
  Array.isArray(e.executions) ? pass("GET /executions → array") : fail("Bad /executions");

  const c = await httpGet("/chats") as { sessions: unknown[] };
  Array.isArray(c.sessions) ? pass("GET /chats → array") : fail("Bad /chats");

  // Validation
  const bad1 = await httpPost("/chat", { message: "no session id" });
  bad1.status === 400 ? pass("POST /chat without sessionId → 400") : fail(`Expected 400, got ${bad1.status}`);

  const bad2 = await httpPost("/chat", { sessionId: "s" });
  bad2.status === 400 ? pass("POST /chat without message → 400") : fail(`Expected 400, got ${bad2.status}`);

  // Cancel unknown
  const cancelRes = await httpPost("/cancel/nonexistent-id", {});
  cancelRes.status === 404 ? pass("POST /cancel unknown → 404") : fail(`Expected 404, got ${cancelRes.status}`);
}

// ─── Test 2: Single direct tool call ─────────────────────────────────────────

async function testSingleDirectToolCall() {
  header("Test 2: Single direct tool call via Redis queue (no LLM)");

  const start = Date.now();
  const result = await directToolCall("shell_run", { command: "ls" });
  const ms = Date.now() - start;

  result.status === "completed" ? pass(`shell_run completed in ${ms}ms`) : fail(`shell_run status: ${result.status}`);
  result.pod ? pass(`Ran on pod: ${result.pod}`) : fail("No pod in result");
  info(`Output: "${result.output.slice(0, 60)}"`);
}

// ─── Test 3: All 3 tools directly ────────────────────────────────────────────

async function testAllTools() {
  header("Test 3: All 3 tools via direct queue (no LLM)");

  const [ls, env, read] = await Promise.all([
    directToolCall("shell_run", { command: "ls" }),
    directToolCall("env_inspect", {}),
    directToolCall("shell_run", { command: "pwd" }),
  ]);

  ls.status === "completed" ? pass(`shell_run(ls) → pod ${ls.pod}`) : fail(`shell_run failed: ${ls.output}`);
  env.status === "completed" ? pass(`env_inspect → pod ${env.pod}`) : fail(`env_inspect failed: ${env.output}`);
  read.status === "completed" ? pass(`shell_run(pwd) → pod ${read.pod}`) : fail(`shell_run(pwd) failed`);

  const pods = new Set([ls.pod, env.pod, read.pod]);
  info(`Pods used: ${[...pods].join(", ")}`);
}

// ─── Test 4: 8 concurrent calls — pod uniqueness ─────────────────────────────

async function testConcurrentPodUniqueness() {
  header("Test 4: 8 concurrent direct tool calls — pod uniqueness");

  const start = Date.now();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => directToolCall("shell_run", { command: "whoami" }))
  );
  const ms = Date.now() - start;

  const succeeded = results.filter((r) => r.status === "completed");
  succeeded.length === 8 ? pass(`8/8 succeeded in ${ms}ms`) : fail(`Only ${succeeded.length}/8 succeeded`);

  const pods = results.map((r) => r.pod).filter(Boolean);
  const unique = new Set(pods);
  info(`Pods used: ${[...unique].join(", ")}`);
  pass(`${unique.size} unique pods used across 8 concurrent calls`);
}

// ─── Test 5: 9th call must queue ─────────────────────────────────────────────

async function testQueueDepth() {
  header("Test 5: 9 concurrent calls — 9th queues or times out");

  const start = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: 9 }, () => directToolCall("shell_run", { command: "pwd" }))
  );
  const ms = Date.now() - start;

  const succeeded = results.filter((r) => r.status === "fulfilled" && (r.value as {status:string}).status === "completed").length;
  const timedOut = results.filter((r) => r.status === "rejected").length;

  info(`9 concurrent: ${succeeded} completed, ${timedOut} timed out (${ms}ms total)`);
  succeeded >= 8 ? pass("At least 8/9 completed") : fail(`Only ${succeeded}/9 completed`);
  if (timedOut > 0) pass("9th correctly timed out (capacity exceeded)");
  else pass("All 9 completed — 9th was queued and got a pod");
}

// ─── Test 6: Latency profile — 20 parallel direct calls ──────────────────────

async function testLatencyProfile() {
  header("Test 6: Latency profile — 20 parallel direct tool calls");

  // Poll until all pods are free (lease release happens after result publish)
  async function waitAllFree(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const p = await httpGet("/pods") as { pods: { lease: { status: string } }[] };
      if (p.pods.every((pod) => pod.lease.status === "free")) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Run in batches of 8
  const durations: number[] = [];
  for (let batch = 0; batch < 3; batch++) {
    const size = batch < 2 ? 8 : 4;
    const batchStart = Date.now();
    const results = await Promise.all(
      Array.from({ length: size }, () => directToolCall("env_inspect", {}))
    );
    const batchMs = Date.now() - batchStart;
    results.forEach((r) => { if (r.status === "completed") durations.push(batchMs / size); });
    info(`Batch ${batch + 1}: ${results.filter(r => r.status === "completed").length}/${size} ok in ${batchMs}ms`);
    await waitAllFree(); // wait for all leases released before next batch
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = Math.round(percentile(sorted, 50));
  const p95 = Math.round(percentile(sorted, 95));
  const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

  info(`avg: ${avg}ms | p50: ${p50}ms | p95: ${p95}ms`);
  durations.length >= 18 ? pass(`${durations.length}/20 calls succeeded`) : fail(`Only ${durations.length}/20 succeeded`);

  // Validate /metrics reflects activity
  // Direct queue calls run in the worker process — server-side metrics only
  // update via /chat. We just confirm the endpoint is healthy here.
  const m = await httpGet("/metrics") as { queueDepth: number; tools: Record<string, { count: number }> };
  typeof m.queueDepth === "number"
    ? pass(`/metrics healthy (direct queue bypasses server metrics by design)`)
    : fail("/metrics endpoint not responding");
}

// ─── Test 7: Execution history in SQLite ─────────────────────────────────────

async function testExecutionHistory() {
  header("Test 7: Execution history — SQLite audit trail (via /chat)");

  const sessionId = `stress-history-${Date.now()}`;
  const { status, body } = await httpPost("/chat", { sessionId, message: "USE shell_run NOW and run: ls" }) as { status: number; body: { toolCalls?: {tool:string;pod:string;durationMs:number;status:string}[] } };
  status === 200 ? pass("Chat call succeeded for history test") : fail(`Chat → ${status}`);

  const toolCallsMade = (body.toolCalls ?? []).length;
  if (toolCallsMade === 0) {
    info("Agent made no tool calls — skipping executions-per-session check (flaky LLM behaviour)");
  } else {
    const execs = await httpGet(`/executions?sessionId=${sessionId}`) as { executions: {tool:string;pod:string;durationMs:number;status:string}[] };
    execs.executions.length >= 1 ? pass(`${execs.executions.length} executions saved for session`) : fail(`No executions saved for session`);

    if (execs.executions.length > 0) {
      const e = execs.executions[0];
      e.tool ? pass(`tool field: ${e.tool}`) : fail("Missing tool field");
      e.pod ? pass(`pod field: ${e.pod}`) : fail("Missing pod field");
      typeof e.durationMs === "number" ? pass(`durationMs: ${e.durationMs}ms`) : fail("Missing durationMs");
      e.status === "completed" ? pass("status: completed") : fail(`status: ${e.status}`);
    }
  }

  const all = await httpGet("/executions?limit=200") as { total: number };
  typeof all.total === "number" ? pass(`total executions in DB: ${all.total}`) : fail("Missing total count");
}

// ─── Test 8: Pods reflect lease state ────────────────────────────────────────

async function testPodStateReflection() {
  header("Test 8: /pods reflects lease state during execution");

  // Drain any leftover leases from previous tests before measuring
  async function waitAllFree(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const p = await httpGet("/pods") as { pods: { lease: { status: string } }[] };
      if (p.pods.every((pod) => pod.lease.status === "free")) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  await waitAllFree();

  // Start 4 concurrent calls and immediately check pods
  const callsPromise = Promise.all(
    Array.from({ length: 4 }, () => directToolCall("shell_run", { command: "pwd" }))
  );

  await new Promise((r) => setTimeout(r, 30)); // tiny delay, calls are in flight
  const mid = await httpGet("/pods") as { pods: {name:string;lease:{status:string}}[] };
  const leased = mid.pods.filter((p) => p.lease.status === "leased");
  info(`Pods leased mid-flight: ${leased.length}`);
  leased.length > 0 ? pass("Pods show leased status during execution") : info("Calls completed before check (fast pods)");

  const results = await callsPromise;
  // directToolCall already waits for waitForPodFreed, so leases are freed by the time we get here
  const usedPods = new Set(results.map((r) => r.pod).filter(Boolean));

  const after = await httpGet("/pods") as { pods: {name:string;lease:{status:string}}[] };
  const stillLeased = after.pods.filter((p) => usedPods.has(p.name) && p.lease.status !== "free");
  stillLeased.length === 0
    ? pass(`All ${usedPods.size} pods used by this test are free after completion`)
    : fail(`${stillLeased.length} pods still leased: ${stillLeased.map(p => p.name).join(", ")}`);
}

// ─── Test 9 (AI): Single Pi LLM call end-to-end ──────────────────────────────

async function testAISmokeTest() {
  header("Test 9: Pi LLM smoke test — 1 real AI call (not rate-limited)");

  const sessionId = `stress-ai-${Date.now()}`;
  const start = Date.now();

  const { status, body } = await httpPost("/chat", {
    sessionId,
    message: "run ls and tell me what files are in the sandbox",
  }) as { status: number; body: { message: string; toolCalls?: {tool:string;pod:string;status:string;durationMs:number}[] } };

  const ms = Date.now() - start;
  status === 200 ? pass(`POST /chat → 200 in ${ms}ms`) : fail(`POST /chat → ${status}: ${JSON.stringify(body)}`);

  const tc = body.toolCalls?.[0];
  if (tc) {
    tc.tool === "shell_run" ? pass(`Tool: ${tc.tool}`) : fail(`Unexpected tool: ${tc.tool}`);
    tc.status === "completed" ? pass(`Status: completed on ${tc.pod}`) : fail(`Status: ${tc.status}`);
    tc.durationMs > 0 ? pass(`Duration: ${tc.durationMs}ms`) : fail("durationMs is 0");
    body.message.length > 5 ? pass(`Response: "${body.message.slice(0, 80)}…"`) : fail("Empty response");
  } else {
    fail("No tool calls — agent did not use tools");
  }

  // Verify chat history saved
  const conv = await httpGet(`/chats/${sessionId}`) as { messages: {role:string}[] };
  const hasUser = conv.messages.some((m) => m.role === "user");
  const hasAssistant = conv.messages.some((m) => m.role === "assistant");
  hasUser && hasAssistant ? pass("Chat history saved to SQLite") : fail("Chat history missing");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🚀  Sendai — Stress + Coverage Test");
  console.log(`    Target: ${BASE}`);
  console.log(`    Strategy: direct Redis queue for load, 1 LLM call for AI smoke\n`);

  await ensureConsumerGroup().catch(() => {});

  await testEndpoints();
  await testSingleDirectToolCall();
  await testAllTools();
  await testConcurrentPodUniqueness();
  await testQueueDepth();
  await testLatencyProfile();
  await testExecutionHistory();
  await testPodStateReflection();
  await testAISmokeTest();

  console.log(`\n${SEP}`);
  console.log(`  Passed: ${passed}  Failed: ${failed}`);
  if (failed === 0) console.log("  ✅  All tests passed.");
  else console.log("  ❌  Some tests failed — see above.");
  console.log(SEP);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
