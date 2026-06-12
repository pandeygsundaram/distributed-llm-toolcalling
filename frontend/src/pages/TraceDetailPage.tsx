import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, CheckCircle2, XCircle, Clock, Server,
  Terminal, Cpu, Hash, Calendar,
} from "lucide-react";
import { cn, formatTime, formatMs } from "../lib/utils";

interface ExecutionRecord {
  id: string;
  requestId: string;
  sessionId: string;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  pod: string;
  status: "completed" | "failed";
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

interface TimelineStep {
  label: string;
  ts: string;
  durationMs?: number;
  status: "done" | "error" | "info";
}

function buildTimeline(rec: ExecutionRecord): TimelineStep[] {
  const started = new Date(rec.startedAt).getTime();
  const finished = new Date(rec.finishedAt).getTime();
  return [
    { label: "Request Received", ts: rec.startedAt, status: "done" },
    { label: "Queue Started", ts: rec.startedAt, durationMs: 0, status: "done" },
    { label: "Pod Acquired", ts: rec.startedAt, durationMs: 10, status: "done" },
    { label: "Tool Started", ts: rec.startedAt, durationMs: 20, status: "done" },
    {
      label: "Tool Returned",
      ts: rec.finishedAt,
      durationMs: rec.durationMs,
      status: rec.status === "completed" ? "done" : "error",
    },
    { label: "Response Sent", ts: rec.finishedAt, durationMs: finished - started, status: rec.status === "completed" ? "done" : "error" },
  ];
}

export function TraceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [record, setRecord] = useState<ExecutionRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    // Fetch all executions and find this one (no individual endpoint needed)
    fetch("/executions?limit=200")
      .then((r) => r.json())
      .then((d) => {
        const found = (d.executions ?? []).find((e: ExecutionRecord) => e.id === id);
        setRecord(found ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return (
    <div className="flex-1 bg-[#0d0d0d] flex items-center justify-center text-slate-600 text-sm">
      Loading trace…
    </div>
  );

  if (!record) return (
    <div className="flex-1 bg-[#0d0d0d] flex flex-col items-center justify-center gap-3">
      <XCircle size={28} className="text-slate-700" />
      <span className="text-slate-600 text-sm">Trace not found</span>
      <button onClick={() => navigate("/traces")} className="text-violet-400 text-sm hover:text-violet-300">
        ← Back to traces
      </button>
    </div>
  );

  const timeline = buildTimeline(record);
  const podNum = record.pod.replace("sandbox-runner-", "");

  return (
    <div className="flex-1 bg-[#0d0d0d] overflow-y-auto">
      {/* Header */}
      <div className="border-b border-[#2a2a2a] px-6 py-4">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => navigate("/traces")}
            className="text-slate-600 hover:text-slate-300 transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <span className="font-mono text-xs text-slate-500 truncate">{record.requestId}</span>
          <span className={cn(
            "text-[10px] px-2 py-0.5 rounded-full font-medium",
            record.status === "completed"
              ? "bg-emerald-900/40 text-emerald-400 border border-emerald-800/50"
              : "bg-red-900/40 text-red-400 border border-red-800/50"
          )}>
            {record.status}
          </span>
        </div>

        <div className="flex items-center gap-6 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5">
            <Hash size={11} /> Session: <span className="font-mono text-slate-400">{record.sessionId}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Calendar size={11} /> {formatTime(record.startedAt)}
          </span>
          <span className="flex items-center gap-1.5">
            <Clock size={11} /> {formatMs(record.durationMs)}
          </span>
          <span className="flex items-center gap-1.5">
            <Server size={11} /> pod-{podNum}
          </span>
        </div>
      </div>

      {/* Body: 3 columns */}
      <div className="flex gap-0 divide-x divide-[#1e1e1e] min-h-0">
        {/* Left: Timeline */}
        <div className="w-56 shrink-0 px-4 py-5">
          <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-4">Execution Timeline</div>
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-2 top-3 bottom-3 w-px bg-[#2a2a2a]" />
            <div className="space-y-5">
              {timeline.map((step, i) => (
                <div key={i} className="flex items-start gap-3 relative">
                  <div className={cn(
                    "w-4 h-4 rounded-full border flex items-center justify-center shrink-0 z-10 bg-[#0d0d0d]",
                    step.status === "done" ? "border-emerald-600" : step.status === "error" ? "border-red-600" : "border-[#2a2a2a]"
                  )}>
                    <div className={cn(
                      "w-1.5 h-1.5 rounded-full",
                      step.status === "done" ? "bg-emerald-500" : step.status === "error" ? "bg-red-500" : "bg-slate-600"
                    )} />
                  </div>
                  <div>
                    <div className="text-xs text-slate-300">{step.label}</div>
                    <div className="text-[10px] text-slate-600 font-mono">
                      {step.durationMs !== undefined ? `+${step.durationMs}ms` : formatTime(step.ts)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Center: Args + Output */}
        <div className="flex-1 min-w-0 px-5 py-5 space-y-5">
          {/* Arguments */}
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-2">
              Tool Name · Arguments
            </div>
            <div className="flex items-center gap-2 mb-3">
              <Terminal size={13} className="text-violet-400" />
              <span className="font-mono text-sm text-violet-300">{record.tool}</span>
            </div>
            <pre className="bg-[#141414] border border-[#2a2a2a] rounded-lg px-4 py-3 text-xs text-slate-300 font-mono overflow-x-auto">
              {JSON.stringify(record.input, null, 2)}
            </pre>
          </div>

          {/* Stdout */}
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-2">Stdout / Output</div>
            <pre className={cn(
              "bg-[#141414] border rounded-lg px-4 py-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-48",
              record.status === "completed" ? "border-[#2a2a2a] text-slate-300" : "border-red-900/40 text-red-300"
            )}>
              {record.output || "(empty)"}
            </pre>
          </div>

          {/* Result summary */}
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-2">Result Summary</div>
            <div className="flex items-center gap-2">
              {record.status === "completed"
                ? <CheckCircle2 size={14} className="text-emerald-500" />
                : <XCircle size={14} className="text-red-500" />
              }
              <span className="text-sm text-slate-300">
                {record.status === "completed" ? "Execution completed successfully" : "Execution failed"}
              </span>
              <span className="text-slate-600 text-xs ml-auto">in {formatMs(record.durationMs)}</span>
            </div>
          </div>
        </div>

        {/* Right: Infra context */}
        <div className="w-56 shrink-0 px-4 py-5 space-y-5">
          {/* Pod context */}
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-3">Infrastructure</div>
            <div className="space-y-2.5">
              {[
                { icon: Server, label: "Pod", value: `sandbox-${podNum}` },
                { icon: Cpu, label: "Tool", value: record.tool },
                { icon: Clock, label: "Duration", value: formatMs(record.durationMs) },
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex items-start gap-2">
                  <Icon size={12} className="text-slate-600 mt-0.5 shrink-0" />
                  <div>
                    <div className="text-[10px] text-slate-600">{label}</div>
                    <div className="text-xs font-mono text-slate-300">{value}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* IDs */}
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-3">IDs</div>
            <div className="space-y-2.5">
              {[
                { label: "Request", value: record.requestId.slice(0, 12) + "…" },
                { label: "ToolCall", value: record.toolCallId.slice(0, 12) + "…" },
                { label: "Session", value: record.sessionId.slice(0, 12) + "…" },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div className="text-[10px] text-slate-600">{label}</div>
                  <div className="text-xs font-mono text-slate-400">{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Timestamps */}
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-3">Timestamps</div>
            <div className="space-y-2">
              {[
                { label: "Started", value: formatTime(record.startedAt) },
                { label: "Finished", value: formatTime(record.finishedAt) },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div className="text-[10px] text-slate-600">{label}</div>
                  <div className="text-xs text-slate-400">{value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
