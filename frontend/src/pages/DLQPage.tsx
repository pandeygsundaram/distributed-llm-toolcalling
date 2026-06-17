import { useState, useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "../lib/utils";

interface DLQItem {
  id: string;
  toolCallId: string;
  tool: string;
  error: string;
  pod: string;
  failedAt: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function DLQPage() {
  const [items, setItems] = useState<DLQItem[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  async function load() {
    try {
      const res = await fetch("/dlq");
      const data = await res.json();
      setItems(data.items ?? []);
      setCount(data.count ?? 0);
      setLastRefresh(new Date());
    } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex-1 bg-[#0d0d0d] overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-5 border-b border-[#2a2a2a] flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <AlertTriangle size={15} className="text-red-400" />
            <h1 className="text-sm font-semibold text-slate-200">Dead Letter Queue</h1>
            {count > 0 && (
              <span className="text-[10px] bg-red-900/50 border border-red-800/50 text-red-300 px-1.5 py-0.5 rounded-full font-mono">
                {count}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-600 mt-1">
            Failed tool calls that exhausted all retries
            {lastRefresh && (
              <span className="ml-2 text-slate-700">· refreshed {timeAgo(lastRefresh.toISOString())}</span>
            )}
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>

      {/* Content */}
      <div className="px-6 py-5">
        {loading && (
          <div className="text-center py-16 text-slate-600 text-sm">Loading…</div>
        )}

        {!loading && items.length === 0 && (
          <div className="text-center py-16">
            <div className="w-12 h-12 rounded-xl bg-emerald-900/20 border border-emerald-800/30 flex items-center justify-center mx-auto mb-3">
              <AlertTriangle size={20} className="text-emerald-600" />
            </div>
            <div className="text-slate-400 text-sm font-medium">DLQ is empty</div>
            <div className="text-slate-600 text-xs mt-1">No failed tool calls — everything is running clean</div>
          </div>
        )}

        {items.length > 0 && (
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-red-900/30 bg-red-950/10 px-4 py-3.5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-mono font-semibold text-red-300">{item.tool}</span>
                      {item.pod && (
                        <span className="text-[10px] text-slate-600">
                          pod-{item.pod.replace("sandbox-runner-", "")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 font-mono bg-[#1a1010] border border-red-950/50 rounded px-2.5 py-1.5 break-all">
                      {item.error}
                    </div>
                    <div className="mt-1.5 text-[10px] text-slate-700 font-mono">
                      tool_call: {item.toolCallId.slice(0, 16)}…
                    </div>
                  </div>
                  <div className={cn(
                    "shrink-0 text-[10px] text-slate-600 whitespace-nowrap mt-0.5"
                  )}>
                    {timeAgo(item.failedAt)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
