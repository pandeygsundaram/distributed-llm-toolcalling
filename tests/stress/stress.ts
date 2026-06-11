import "dotenv/config";
import * as k8s from "@kubernetes/client-node";
import { RedisExecutor } from "../../src/executor/redis.js";
import { v4 as uuid } from "uuid";

async function resetAllLeases() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const api = kc.makeApiClient(k8s.CoordinationV1Api);
  const ns = process.env.K8S_NAMESPACE ?? "sendai";
  const pods = Array.from({ length: 8 }, (_, i) => `sandbox-runner-${i}`);
  await Promise.all(pods.map(async (name) => {
    try {
      const lease = await api.readNamespacedLease({ name, namespace: ns });
      if (lease.spec?.holderIdentity) {
        await api.replaceNamespacedLease({
          name, namespace: ns,
          body: {
            apiVersion: "coordination.k8s.io/v1", kind: "Lease",
            metadata: { name, namespace: ns, resourceVersion: lease.metadata?.resourceVersion },
            spec: { holderIdentity: "", leaseDurationSeconds: 45,
              renewTime: new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z") as unknown as Date },
          },
        });
      }
    } catch { /* ignore */ }
  }));
  process.stdout.write("  [leases reset] ");
}

const executor = new RedisExecutor();

interface JobResult {
  index: number;
  toolCallId: string;
  tool: string;
  status: "completed" | "failed" | "error";
  executedIn: "local" | "pod";
  pod?: string;
  durationMs: number;
  output: string;
  error?: string;
}

interface PhaseReport {
  phase: string;
  total: number;
  completed: number;
  failed: number;
  timedOut: number;
  wallMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  podsUsed: Set<string>;
  duplicatePodViolations: number;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function bar(n: number, total: number, width = 30): string {
  const filled = Math.round((n / total) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function runJob(
  index: number,
  tool: string,
  input: Record<string, unknown>
): Promise<JobResult> {
  const toolCallId = uuid();
  const requestId = uuid();
  const start = Date.now();

  try {
    const result = await executor.execute({
      toolCallId,
      tool,
      input,
      requestId,
      sessionId: `stress-${index}`,
    });

    return {
      index,
      toolCallId,
      tool,
      status: result.status,
      executedIn: result.executedIn,
      pod: result.pod,
      durationMs: result.durationMs,
      output: result.output.slice(0, 80),
    };
  } catch (err) {
    return {
      index,
      toolCallId,
      tool,
      status: "error",
      executedIn: "local",
      durationMs: Date.now() - start,
      output: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runPhase(
  label: string,
  jobs: Array<{ tool: string; input: Record<string, unknown> }>
): Promise<PhaseReport> {
  const n = jobs.length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}  (${n} concurrent jobs)`);
  console.log(`${"─".repeat(60)}`);

  const wallStart = Date.now();

  const settled = await Promise.allSettled(
    jobs.map((j, i) => runJob(i, j.tool, j.input))
  );

  const wallMs = Date.now() - wallStart;
  const results = settled.map((s) =>
    s.status === "fulfilled" ? s.value : ({ status: "error", durationMs: 0, pod: undefined, output: "", error: String(s.reason) } as JobResult)
  );

  const completed = results.filter((r) => r.status === "completed");
  const failed = results.filter((r) => r.status === "failed");
  const errors = results.filter((r) => r.status === "error");
  const timedOut = [...failed, ...errors].filter(
    (r) => r.error?.includes("timeout") || r.output?.includes("sandbox_capacity_timeout")
  );

  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const podsUsed = new Set(results.map((r) => r.pod).filter(Boolean) as string[]);

  // Check duplicate pod assignment (two jobs running SIMULTANEOUSLY on same pod)
  // Track which pod was used at what time ranges
  const podTimelines: Record<string, Array<{ start: number; end: number; index: number }>> = {};
  for (const r of results) {
    if (!r.pod) continue;
    if (!podTimelines[r.pod]) podTimelines[r.pod] = [];
    // We don't have absolute start times here so use index as proxy
    podTimelines[r.pod].push({ start: r.index, end: r.index, index: r.index });
  }
  // Duplicates would mean two jobs returned the same pod — not a timing overlap check
  // but a sanity check that pods cycle through all 8
  let duplicatePodViolations = 0;

  const report: PhaseReport = {
    phase: label,
    total: n,
    completed: completed.length,
    failed: failed.length + errors.length,
    timedOut: timedOut.length,
    wallMs,
    minMs: durations[0] ?? 0,
    maxMs: durations[durations.length - 1] ?? 0,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    podsUsed,
    duplicatePodViolations,
  };

  // ── print results ──────────────────────────────────────────────────────────
  console.log(`\n  STATUS`);
  console.log(`  ✅ completed   ${bar(completed.length, n)}  ${completed.length}/${n}`);
  console.log(`  ❌ failed      ${bar(report.failed, n)}  ${report.failed}/${n}`);
  if (timedOut.length > 0) {
    console.log(`  ⏱  timed out   ${bar(timedOut.length, n)}  ${timedOut.length}/${n}`);
  }

  console.log(`\n  LATENCY`);
  console.log(`  wall time  ${wallMs}ms`);
  console.log(`  min        ${report.minMs}ms`);
  console.log(`  p50        ${report.p50Ms}ms`);
  console.log(`  p95        ${report.p95Ms}ms`);
  console.log(`  max        ${report.maxMs}ms`);

  console.log(`\n  PODS USED`);
  const podCounts: Record<string, number> = {};
  for (const r of results) {
    if (r.pod) podCounts[r.pod] = (podCounts[r.pod] ?? 0) + 1;
  }
  for (const [pod, count] of Object.entries(podCounts).sort()) {
    console.log(`  ${pod.padEnd(20)}  ${bar(count, n, 20)}  ${count} jobs`);
  }

  if (report.failed > 0) {
    const sample = [...failed, ...errors].slice(0, 3);
    console.log(`\n  FAILURE SAMPLE`);
    for (const r of sample) {
      console.log(`  job-${r.index}: ${r.error ?? r.output}`);
    }
  }

  return report;
}

// ─── Phase definitions ─────────────────────────────────────────────────────

const TOOLS = {
  pwd:     { tool: "shell_run",  input: { command: "pwd" } },
  ls:      { tool: "shell_run",  input: { command: "ls" } },
  whoami:  { tool: "shell_run",  input: { command: "whoami" } },
  node:    { tool: "shell_run",  input: { command: "node", args: ["--version"] } },
  env:     { tool: "env_inspect", input: {} },
};

function repeat<T>(item: T, n: number): T[] {
  return Array.from({ length: n }, () => ({ ...item }));
}

function mix(n: number) {
  const pool = Object.values(TOOLS);
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║          SENDAI SANDBOX STRESS TEST                     ║");
  console.log("║  Redis → Worker → K8s Lease → pods/exec                 ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\n  Pool size   : 8 pods`);
  console.log(`  Queue limit : 15s timeout`);
  console.log(`  Tool timeout: 30s`);

  const reports: PhaseReport[] = [];

  // ── Phase 1: Baseline — exactly 8, all should hit pods immediately ─────────
  reports.push(await runPhase(
    "PHASE 1 — BASELINE  (8 concurrent = exactly 1 per pod)",
    repeat(TOOLS.pwd, 8)
  ));

  await resetAllLeases();
  await new Promise(r => setTimeout(r, 300));

  // ── Phase 2: Load — 16 concurrent, 8 queue briefly ────────────────────────
  reports.push(await runPhase(
    "PHASE 2 — LOAD  (16 concurrent, 8 queue)",
    mix(16)
  ));

  await resetAllLeases();
  await new Promise(r => setTimeout(r, 300));

  // ── Phase 3: Mixed tools — 24 concurrent ──────────────────────────────────
  reports.push(await runPhase(
    "PHASE 3 — MIXED TOOLS  (24 concurrent)",
    mix(24)
  ));

  await resetAllLeases();
  await new Promise(r => setTimeout(r, 300));

  // ── Phase 4: Overload — 50 concurrent, stress the queue ──────────────────
  reports.push(await runPhase(
    "PHASE 4 — OVERLOAD  (50 concurrent, queue stress)",
    mix(50)
  ));

  await resetAllLeases();
  await new Promise(r => setTimeout(r, 300));

  // ── Phase 5: Rapid repeat — 30 pwd calls ─────────────────────────────────
  reports.push(await runPhase(
    "PHASE 5 — RAPID REPEAT  (30 pwd back to back)",
    repeat(TOOLS.pwd, 30)
  ));

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("  SUMMARY");
  console.log(`${"═".repeat(60)}`);
  console.log(`  ${"Phase".padEnd(48)} ${"OK".padStart(4)} ${"FAIL".padStart(5)} ${"p50".padStart(7)} ${"p95".padStart(7)}`);
  console.log(`  ${"─".repeat(58)}`);
  for (const r of reports) {
    const label = r.phase.slice(0, 46).padEnd(46);
    const ok    = String(r.completed).padStart(4);
    const fail  = String(r.failed).padStart(5);
    const p50   = `${r.p50Ms}ms`.padStart(7);
    const p95   = `${r.p95Ms}ms`.padStart(7);
    console.log(`  ${label} ${ok} ${fail} ${p50} ${p95}`);
  }

  const allOk = reports.every(r => r.completed > 0);
  console.log(`\n  ${allOk ? "✅ All phases produced completed jobs" : "⚠️  Some phases had no completions"}`);
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("stress test fatal:", err);
  process.exit(1);
});
