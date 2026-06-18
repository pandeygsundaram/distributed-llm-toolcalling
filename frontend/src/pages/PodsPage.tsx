import { useState, useCallback, useEffect, useRef } from "react";
import { Server, Activity, Zap, TrendingUp } from "lucide-react";
import { cn, formatMs } from "../lib/utils";
import { useWebSocket, type PodState, type MetricsSnapshot, type ExecutionRecord } from "../hooks/useWebSocket";

interface HpaState {
  currentReplicas: number;
  desiredReplicas: number;
  minReplicas: number;
  maxReplicas: number;
}

interface QueuePoint { ts: number; v: number }

function Sparkline({ points, height = 40 }: { points: QueuePoint[]; height?: number }) {
  const width = 240;
  if (points.length < 2) return <div style={{ width, height }} className="flex items-end text-[10px] text-slate-700">no data</div>;

  const max = Math.max(...points.map(p => p.v), 1);
  const step = width / (points.length - 1);

  const pathD = points.map((p, i) => {
    const x = i * step;
    const y = height - (p.v / max) * (height - 4) - 2;
    return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");

  const fillD = pathD + ` L ${((points.length - 1) * step).toFixed(1)} ${height} L 0 ${height} Z`;
  const latest = points[points.length - 1].v;

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height} className="overflow-visible">
        <defs>
          <linearGradient id="qfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f97316" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#f97316" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={fillD} fill="url(#qfill)" />
        <path d={pathD} stroke="#f97316" strokeWidth="1.5" fill="none" />
        <circle
          cx={((points.length - 1) * step).toFixed(1)}
          cy={(height - (latest / max) * (height - 4) - 2).toFixed(1)}
          r="2.5"
          fill="#f97316"
        />
      </svg>
      <div className="absolute top-0 right-0 font-mono text-[10px] text-orange-400">{latest}</div>
    </div>
  );
}

function HpaBar({ hpa }: { hpa: HpaState }) {
  const pct = ((hpa.currentReplicas - hpa.minReplicas) / (hpa.maxReplicas - hpa.minReplicas)) * 100;
  const scaling = hpa.desiredReplicas > hpa.currentReplicas;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-500 flex items-center gap-1.5">
          <TrendingUp size={11} className="text-slate-600" />
          HPA Replicas
        </span>
        <span className="font-mono text-slate-200">
          {hpa.currentReplicas}
          {scaling && (
            <span className="text-amber-400 ml-1 animate-pulse">→ {hpa.desiredReplicas}</span>
          )}
          <span className="text-slate-600"> / {hpa.maxReplicas}</span>
        </span>
      </div>
      <div className="w-full h-1.5 bg-[#2a2a2a] rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            scaling ? "bg-amber-400" : pct > 50 ? "bg-emerald-500" : "bg-emerald-700"
          )}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-slate-700">
        <span>min {hpa.minReplicas}</span>
        <span>max {hpa.maxReplicas}</span>
      </div>
    </div>
  );
}

export function PodsPage() {
  const [pods, setPods] = useState<PodState[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [queueWaiters, setQueueWaiters] = useState(0);
  const [hpa, setHpa] = useState<HpaState>({ currentReplicas: 0, desiredReplicas: 0, minReplicas: 8, maxReplicas: 32 });
  const [queueHistory, setQueueHistory] = useState<QueuePoint[]>([]);
  const lastQueueRef = useRef<number>(-1);

  useEffect(() => {
    fetch("/api/pods").then(r => r.json()).then(d => { if (d.pods) setPods(d.pods); }).catch(() => {});
  }, []);

  const handleEvent = useCallback((ev: Parameters<Parameters<typeof useWebSocket>[0]>[0]) => {
    if (ev.type === "pods_update") setPods(ev.data.pods);
    if (ev.type === "metrics_update") {
      setMetrics(ev.data);
      // Append to queue depth history (deduplicate consecutive same values for cleaner sparkline)
      const depth = ev.data.queueDepth ?? 0;
      if (depth !== lastQueueRef.current) {
        lastQueueRef.current = depth;
        setQueueHistory(prev => [...prev.slice(-119), { ts: Date.now(), v: depth }]);
      }
    }
    if (ev.type === "execution_update") setExecutions((p) => [ev.data, ...p].slice(0, 50));
    if (ev.type === "queue_update") setQueueWaiters(ev.data.waiters);
    if (ev.type === "hpa_update") setHpa(ev.data);
  }, []);

  useWebSocket(handleEvent);

  const freePods = pods.filter((p) => p.lease.status === "free").length;
  const busyPods = pods.filter((p) => p.lease.status === "leased").length;
  const totalExecs = metrics ? Object.values(metrics.tools).reduce((s, t) => s + t.count, 0) : 0;
  const callsPerSec = (metrics as any)?.callsPerSec ?? 0;

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
          <span><span className="text-slate-300 font-mono">{totalExecs}</span> total execs</span>
          {callsPerSec > 0 && (
            <span className="flex items-center gap-1">
              <Zap size={11} className="text-sky-400" />
              <span className="text-sky-400 font-mono">{callsPerSec}</span>
              <span>calls/sec</span>
            </span>
          )}
        </div>
      </div>

      {/* HPA + Queue sparkline row */}
      <div className="px-6 py-4 border-b border-[#2a2a2a] grid grid-cols-2 gap-6">
        <div className="space-y-3">
          <HpaBar hpa={hpa.currentReplicas > 0 ? hpa : { ...hpa, currentReplicas: pods.length, desiredReplicas: pods.length }} />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-2">Queue Depth (live)</div>
          <Sparkline points={queueHistory} />
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
              "rounded-xl border p-4 transition-all duration-300",
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
                  <span className="font-mono text-sm text-slate-200">runner-{num}</span>
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
              return [
                { label: "p50 Latency", value: `${p50}ms`, icon: Activity },
                { label: "p95 Latency", value: `${p95}ms`, icon: Activity },
                { label: "p99 Latency", value: `${p99}ms`, icon: Activity },
                { label: "Queue Depth", value: metrics.queueDepth, icon: Server },
                { label: "Tool Execs", value: totalExecs, icon: Server },
                { label: "Throughput", value: `${callsPerSec}/s`, icon: Zap },
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
