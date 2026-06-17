import { useState, useRef, useEffect, useCallback } from "react";
import { Send, X, Terminal, CheckCircle2, XCircle, Clock } from "lucide-react";
import { cn, formatMs } from "../lib/utils";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { useWebSocket, type PodState, type MetricsSnapshot, type ExecutionRecord } from "../hooks/useWebSocket";

interface ToolCall {
  toolCallId: string;
  tool: string;
  status: "completed" | "failed";
  executedIn: "local" | "pod";
  pod?: string;
  durationMs: number;
  queuePosition?: number;
  queueWaitMs?: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  loading?: boolean;
}

interface Props {
  sessionId: string;
  onMessageSent?: () => void;
}

// ─── Pod Monitor ──────────────────────────────────────────────────────────────

function PodMonitor({ pods, metrics, executions }: {
  pods: PodState[];
  metrics: MetricsSnapshot | null;
  executions: ExecutionRecord[];
}) {
  return (
    <div className="w-72 shrink-0 flex flex-col border-l border-[#2a2a2a] bg-[#111]">
      <div className="px-4 py-3 border-b border-[#2a2a2a]">
        <h2 className="text-xs font-semibold text-slate-300 uppercase tracking-widest">Sandbox Pod Monitor</h2>
      </div>

      {/* Pods list */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5 min-h-0">
        {pods.length === 0 && (
          <div className="text-xs text-slate-600 py-4 text-center">Connecting to pods…</div>
        )}
        {pods.map((pod) => {
          const status = pod.lease.status;
          const num = pod.name.replace("sandbox-runner-", "");
          const isLeased = status === "leased";
          const holder = isLeased ? (pod.lease as { holderIdentity: string }).holderIdentity : null;
          const toolId = holder?.split(":")[3]?.slice(0, 8) ?? null;

          return (
            <div
              key={pod.name}
              className={cn(
                "rounded-lg border px-3 py-2 text-xs transition-colors",
                isLeased
                  ? "border-amber-700/50 bg-amber-950/20"
                  : status === "free"
                  ? "border-[#2a2a2a] bg-[#161616]"
                  : "border-[#2a2a2a] bg-[#161616]"
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    isLeased ? "bg-amber-400 animate-pulse" : "bg-emerald-500"
                  )} />
                  <span className="font-mono text-slate-300">sandbox-{num}</span>
                </div>
                <span className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded",
                  isLeased ? "bg-amber-900/50 text-amber-300" : "bg-emerald-900/30 text-emerald-400"
                )}>
                  {isLeased ? "active" : "idle"}
                </span>
              </div>
              {isLeased && toolId && (
                <div className="text-[10px] text-slate-500 font-mono truncate">
                  tool: {toolId}…
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Metrics bar */}
      {metrics && (
        <div className="border-t border-[#2a2a2a] px-3 py-2.5">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
            {(() => {
              const toolNames = Object.keys(metrics.tools);
              const totalExecs = toolNames.reduce((s, t) => s + metrics.tools[t].count, 0);
              const p50 = toolNames.length ? metrics.tools[toolNames[0]].p50 : 0;
              const p95 = toolNames.length ? metrics.tools[toolNames[0]].p95 : 0;
              const successRate = executions.length
                ? Math.round(executions.filter(e => e.status === "completed").length / executions.length * 100)
                : null;
              return [
                ["Busy pods", `${metrics.podsInUse}`],
                ["Queue", `${metrics.queueDepth}`],
                ["p50", `${p50}ms`],
                ["p95", `${p95}ms`],
                ["Execs", `${totalExecs}`],
                ["Success", successRate !== null ? `${successRate}%` : "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-slate-600">{k}</span>
                  <span className="text-slate-400 font-mono">{v}</span>
                </div>
              ));
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";

  return (
    <div className={cn("flex flex-col gap-2", isUser ? "items-end" : "items-start")}>
      <div className={cn("flex items-start gap-2.5 max-w-[85%]", isUser && "flex-row-reverse")}>
        {/* Avatar */}
        <div className={cn(
          "w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold mt-0.5",
          isUser ? "bg-violet-600 text-white" : "bg-[#2a2a2a] text-slate-300"
        )}>
          {isUser ? "U" : "A"}
        </div>

        <div className={cn(
          "rounded-xl px-3.5 py-2.5 leading-relaxed",
          isUser
            ? "bg-violet-600 text-white text-sm rounded-tr-sm"
            : "bg-[#161616] border border-[#252525] rounded-tl-sm",
          msg.loading && "animate-pulse"
        )}>
          {msg.loading ? (
            <span className="flex gap-1 items-center text-slate-400">
              <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce [animation-delay:300ms]" />
            </span>
          ) : isUser ? (
            <span className="whitespace-pre-wrap text-sm">{msg.content}</span>
          ) : (
            <MarkdownMessage content={msg.content} />
          )}
        </div>
      </div>

      {/* Tool call badges */}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5 max-w-[90%]", isUser ? "justify-end" : "ml-8")}>
          {msg.toolCalls.map((tc) => (
            <div
              key={tc.toolCallId}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-mono",
                tc.status === "completed"
                  ? "bg-emerald-950/40 border-emerald-800/50 text-emerald-300"
                  : "bg-red-950/40 border-red-800/50 text-red-300"
              )}
            >
              {tc.status === "completed"
                ? <CheckCircle2 size={11} />
                : <XCircle size={11} />
              }
              <Terminal size={11} className="text-slate-500" />
              <span>{tc.tool}</span>
              {tc.pod && (
                <span className="text-slate-500">
                  · pod-{tc.pod.replace("sandbox-runner-", "")}
                </span>
              )}
              <Clock size={10} className="text-slate-600" />
              <span className="text-slate-500">{formatMs(tc.durationMs)}</span>
              {tc.queueWaitMs && tc.queueWaitMs > 100 && (
                <span className="text-amber-500">+{formatMs(tc.queueWaitMs)} wait</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ChatPage ─────────────────────────────────────────────────────────────────

export function ChatPage({ sessionId, onMessageSent }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pods, setPods] = useState<PodState[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const activeRequestRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load history when session changes
  useEffect(() => {
    setMessages([]);
    if (!sessionId) return;
    fetch(`/chats/${sessionId}`)
      .then((r) => r.json())
      .then((d) => {
        const msgs: ChatMessage[] = (d.messages ?? []).map((m: {
          id: string; role: string; content: string; toolCalls?: ToolCall[] | string;
        }) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          toolCalls: Array.isArray(m.toolCalls)
            ? m.toolCalls
            : m.toolCalls
            ? JSON.parse(m.toolCalls)
            : undefined,
        }));
        setMessages(msgs);
      })
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleWsEvent = useCallback((ev: Parameters<Parameters<typeof useWebSocket>[0]>[0]) => {
    if (ev.type === "pods_update") setPods(ev.data.pods);
    if (ev.type === "metrics_update") setMetrics(ev.data);
    if (ev.type === "execution_update") setExecutions((p) => [ev.data, ...p].slice(0, 100));
  }, []);

  useWebSocket(handleWsEvent);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);

    const loadingId = crypto.randomUUID();
    setMessages((p) => [
      ...p,
      { id: crypto.randomUUID(), role: "user", content: text },
      { id: loadingId, role: "assistant", content: "", loading: true },
    ]);

    try {
      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: text }),
      });

      if (res.status === 429) {
        setMessages((p) =>
          p.map((m) => m.id === loadingId
            ? { ...m, content: "Too many concurrent requests — all pods are busy. Please wait a moment and try again.", loading: false }
            : m
          )
        );
        return;
      }

      const data = await res.json();
      activeRequestRef.current = data.requestId;
      setMessages((p) =>
        p.map((m) =>
          m.id === loadingId
            ? { ...m, content: data.message, toolCalls: data.toolCalls, loading: false }
            : m
        )
      );
      onMessageSent?.();
    } catch {
      setMessages((p) =>
        p.map((m) => m.id === loadingId ? { ...m, content: "Error: request failed", loading: false } : m)
      );
    } finally {
      setSending(false);
      activeRequestRef.current = null;
    }
  }

  async function cancel() {
    const id = activeRequestRef.current;
    if (id) await fetch(`/cancel/${id}`, { method: "POST" });
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Chat panel */}
      <div className="flex flex-col flex-1 min-w-0 bg-[#0d0d0d]">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-3 pb-20">
              <div className="w-12 h-12 rounded-xl bg-violet-600/20 border border-violet-700/30 flex items-center justify-center">
                <Terminal size={22} className="text-violet-400" />
              </div>
              <div>
                <div className="text-slate-300 font-medium text-sm">Agent ready</div>
                <div className="text-slate-600 text-xs mt-1">
                  Try: <em className="text-slate-500">"run ls and tell me what you see"</em>
                </div>
              </div>
            </div>
          )}
          {messages.map((m) => <MessageBubble key={m.id} msg={m} />)}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-[#2a2a2a] px-4 py-3 bg-[#111]">
          <div className="flex gap-2 items-end">
            <textarea
              rows={1}
              className="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg px-3.5 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-violet-600/60 resize-none leading-relaxed"
              placeholder="Message the agent…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              disabled={sending}
            />
            {sending ? (
              <button onClick={cancel}
                className="shrink-0 w-9 h-9 rounded-lg bg-red-600/80 hover:bg-red-500 flex items-center justify-center transition-colors">
                <X size={15} className="text-white" />
              </button>
            ) : (
              <button onClick={send} disabled={!input.trim()}
                className="shrink-0 w-9 h-9 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-30 flex items-center justify-center transition-colors">
                <Send size={14} className="text-white" />
              </button>
            )}
          </div>
          <div className="text-[10px] text-slate-700 mt-1.5 px-1">
            Session: <span className="font-mono">{sessionId}</span>
          </div>
        </div>
      </div>

      <PodMonitor pods={pods} metrics={metrics} executions={executions} />
    </div>
  );
}
