import { useState, useCallback, useEffect } from "react";
import { Server, Activity } from "lucide-react";
import { cn, formatMs } from "../lib/utils";
import { useWebSocket, type PodState, type MetricsSnapshot, type ExecutionRecord } from "../hooks/useWebSocket";

export function PodsPage() {
  const [pods, setPods] = useState<PodState[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [queueWaiters, setQueueWaiters] = useState(0);

  // Initial fetch so pods show immediately without waiting for first WS tick
  useEffect(() => {
    fetch("/api/pods").then(r => r.json()).then(d => { if (d.pods) setPods(d.pods); }).catch(() => {});
  }, []);

  const handleEvent = useCallback((ev: Parameters<Parameters<typeof useWebSocket>[0]>[0]) => {
    if (ev.type === "pods_update") setPods(ev.data.pods);
    if (ev.type === "metrics_update") setMetrics(ev.data);
    if (ev.type === "execution_update") setExecutions((p) => [ev.data, ...p].slice(0, 50));
    if (ev.type === "queue_update") setQueueWaiters(ev.data.waiters);
  }, []);

  useWebSocket(handleEvent);

  const freePods = pods.filter((p) => p.lease.status === "free").length;
  const busyPods = pods.filter((p) => p.lease.status === "leased").length;

  return (
    <div className="flex-1 bg-[#0d0d0d] overflow-y-auto">
      <div className="px-6 py-5 border-b border-[#2a2a2a]">
        <h1 className="text-sm font-semibold text-slate-200">Sandbox Pod Monitor</h1>
        <div className="flex gap-4 mt-2 text-xs text-slate-500">
          <span><span className="text-emerald-400 font-mono">{freePods}</span> idle</span>
          <span><span className="text-amber-400 font-mono">{busyPods}</span> active</span>
          {queueWaiters > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
              <span className="text-orange-400 font-mono">{queueWaiters}</span>
              <span>waiting</span>
            </span>
          )}
          {metrics && <span><span className="text-slate-300 font-mono">{Object.values(metrics.tools).reduce((s, t) => s + t.count, 0)}</span> total execs</span>}
        </div>
      </div>

      {/* Pod grid */}
      <div className="px-6 py-5 grid grid-cols-2 gap-3">
        {pods.map((pod) => {
          const status = pod.lease.status;
          const num = pod.name.replace("sandbox-runner-", "");
          const isLeased = status === "leased";
          const holder = isLeased ? (pod.lease as { holderIdentity: string }).holderIdentity : null;
          const parts = holder?.split(":") ?? [];
          const toolId = parts[3]?.slice(0, 8) ?? null;
          const reqId = parts[1]?.slice(0, 8) ?? null;

          return (
            <div key={pod.name} className={cn(
              "rounded-xl border p-4 transition-all",
              isLeased
                ? "border-amber-700/40 bg-amber-950/10"
                : "border-[#2a2a2a] bg-[#141414]"
            )}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    isLeased ? "bg-amber-400 animate-pulse" : "bg-emerald-500"
                  )} />
                  <span className="font-mono text-sm text-slate-200">sandbox-runner-{num}</span>
                </div>
                <span className={cn(
                  "text-[10px] px-2 py-0.5 rounded border",
                  isLeased
                    ? "bg-amber-900/20 border-amber-800/40 text-amber-300"
                    : "bg-emerald-900/20 border-emerald-800/40 text-emerald-400"
                )}>
                  {isLeased ? "active" : "idle"}
                </span>
              </div>

              {isLeased ? (
                <div className="space-y-1.5 text-[11px] text-slate-500">
                  {toolId && <div className="flex justify-between"><span>tool call</span><span className="font-mono text-slate-400">{toolId}…</span></div>}
                  {reqId && <div className="flex justify-between"><span>request</span><span className="font-mono text-slate-400">{reqId}…</span></div>}
                </div>
              ) : (
                <div className="text-[11px] text-slate-700">Ready to accept tool calls</div>
              )}
            </div>
          );
        })}
        {pods.length === 0 && (
          <div className="col-span-2 text-center py-12 text-slate-600 text-sm">
            Connecting to pod monitor…
          </div>
        )}
      </div>

      {/* Metrics */}
      {metrics && (
        <div className="px-6 py-4 border-t border-[#2a2a2a]">
          <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-3">System Metrics</div>
          <div className="grid grid-cols-3 gap-3">
            {(() => {
              const toolNames = Object.keys(metrics.tools);
              const p50 = toolNames.length ? metrics.tools[toolNames[0]].p50 : 0;
              const p95 = toolNames.length ? metrics.tools[toolNames[0]].p95 : 0;
              const p99 = toolNames.length ? metrics.tools[toolNames[0]].p99 : 0;
              const totalExecs = toolNames.reduce((s, t) => s + metrics.tools[t].count, 0);
              return [
                { label: "p50 Latency", value: `${p50}ms`, icon: Activity },
                { label: "p95 Latency", value: `${p95}ms`, icon: Activity },
                { label: "p99 Latency", value: `${p99}ms`, icon: Activity },
                { label: "Queue Depth", value: metrics.queueDepth, icon: Server },
                { label: "Tool Executions", value: totalExecs, icon: Server },
                { label: "Pods in Use", value: metrics.podsInUse, icon: Server },
              ];
            })().map(({ label, value, icon: Icon }) => (
              <div key={label} className="bg-[#141414] border border-[#2a2a2a] rounded-lg px-3 py-2.5">
                <div className="flex items-center gap-1.5 mb-1">
                  <Icon size={11} className="text-slate-600" />
                  <span className="text-[10px] text-slate-600">{label}</span>
                </div>
                <div className="font-mono text-sm text-slate-200">{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent executions */}
      {executions.length > 0 && (
        <div className="px-6 py-4 border-t border-[#2a2a2a]">
          <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-3">Live Execution Feed</div>
          <div className="space-y-1">
            {executions.slice(0, 15).map((e) => (
              <div key={e.id} className="flex items-center gap-3 text-xs">
                <div className={cn("w-1.5 h-1.5 rounded-full shrink-0",
                  e.status === "completed" ? "bg-emerald-500" : "bg-red-500"
                )} />
                <span className="font-mono text-slate-400 w-24 truncate">{e.tool}</span>
                <span className="text-slate-600">pod-{e.pod.replace("sandbox-runner-", "")}</span>
                <span className="text-slate-700 ml-auto">{formatMs(e.durationMs)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
