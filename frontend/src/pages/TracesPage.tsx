import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, XCircle, Clock, Terminal, ChevronRight } from "lucide-react";
import { cn, formatTime, formatMs } from "../lib/utils";

interface ExecutionRecord {
  id: string;
  requestId: string;
  sessionId: string;
  toolCallId: string;
  tool: string;
  pod: string;
  status: "completed" | "failed";
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

export function TracesPage() {
  const [records, setRecords] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/executions?limit=100")
      .then((r) => r.json())
      .then((d) => setRecords(d.executions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex-1 bg-[#0d0d0d] overflow-y-auto">
      <div className="px-6 py-5 border-b border-[#2a2a2a]">
        <h1 className="text-sm font-semibold text-slate-200">Execution Traces</h1>
        <p className="text-xs text-slate-600 mt-0.5">{records.length} tool executions recorded</p>
      </div>

      {loading && (
        <div className="text-xs text-slate-600 px-6 py-8">Loading…</div>
      )}

      {!loading && records.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Terminal size={28} className="text-slate-700" />
          <div className="text-slate-600 text-sm">No executions yet. Send a chat message to generate traces.</div>
        </div>
      )}

      <div className="divide-y divide-[#1e1e1e]">
        {records.map((r) => (
          <div
            key={r.id}
            onClick={() => navigate(`/traces/${r.id}`)}
            className="flex items-center gap-4 px-6 py-3.5 hover:bg-[#141414] cursor-pointer group transition-colors"
          >
            {/* Status icon */}
            <div className="shrink-0">
              {r.status === "completed"
                ? <CheckCircle2 size={16} className="text-emerald-500" />
                : <XCircle size={16} className="text-red-500" />
              }
            </div>

            {/* Tool + session */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-slate-200">{r.tool}</span>
                <span className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded",
                  r.status === "completed"
                    ? "bg-emerald-900/30 text-emerald-400"
                    : "bg-red-900/30 text-red-400"
                )}>
                  {r.status}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-0.5 text-[11px] text-slate-600">
                <span className="font-mono truncate max-w-[160px]">{r.requestId}</span>
                <span>pod-{r.pod.replace("sandbox-runner-", "")}</span>
                <span>{r.sessionId}</span>
              </div>
            </div>

            {/* Duration + time */}
            <div className="flex items-center gap-4 text-xs text-slate-500 shrink-0">
              <span className="flex items-center gap-1">
                <Clock size={11} />
                {formatMs(r.durationMs)}
              </span>
              <span>{formatTime(r.startedAt)}</span>
              <ChevronRight size={14} className="text-slate-700 group-hover:text-slate-400 transition-colors" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
