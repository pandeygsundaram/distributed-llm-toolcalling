import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  User, Bot, Terminal, CheckCircle2, XCircle,
  Clock, Server, Hash, Layers, ArrowLeft, Zap,
} from "lucide-react";
import { cn, formatTime, formatMs } from "../lib/utils";
import { useWebSocket, type ToolCallLiveEvent } from "../hooks/useWebSocket";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: string;
  createdAt: string;
}

interface ParsedToolCall {
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  status: "completed" | "failed";
  executedIn?: string;
  pod?: string;
  durationMs: number;
  queuePosition?: number;
  queueWaitMs?: number;
}

type TraceItem =
  | { kind: "user";      id: string; content: string; createdAt: string; turnIndex: number }
  | { kind: "tool_call"; id: string; tc: ParsedToolCall; live?: boolean; turnIndex: number }
  | { kind: "assistant"; id: string; content: string; createdAt: string; toolCount: number; totalToolMs: number; turnIndex: number };

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TOOL_COLORS: Record<string, { bg: string; text: string; bar: string }> = {
  shell_run:    { bg: "bg-blue-900/30",    text: "text-blue-300",    bar: "bg-blue-500" },
  fs_read:      { bg: "bg-amber-900/30",   text: "text-amber-300",   bar: "bg-amber-500" },
  fs_write:     { bg: "bg-orange-900/30",  text: "text-orange-300",  bar: "bg-orange-500" },
  env_inspect:  { bg: "bg-purple-900/30",  text: "text-purple-300",  bar: "bg-purple-500" },
  math_compute: { bg: "bg-emerald-900/30", text: "text-emerald-300", bar: "bg-emerald-500" },
};

function toolStyle(tool: string) {
  return TOOL_COLORS[tool] ?? { bg: "bg-slate-800/40", text: "text-slate-300", bar: "bg-slate-500" };
}

function buildItems(messages: ChatMessage[], live: ToolCallLiveEvent[]): TraceItem[] {
  const items: TraceItem[] = [];
  const committed = new Set<string>();
  let turn = 0;

  for (const msg of messages) {
    if (msg.role === "user") {
      turn++;
      items.push({ kind: "user", id: msg.id, content: msg.content, createdAt: msg.createdAt, turnIndex: turn });
    } else {
      let tcs: ParsedToolCall[] = [];
      if (msg.toolCalls) { try { tcs = JSON.parse(msg.toolCalls); } catch {} }
      for (const tc of tcs) {
        committed.add(tc.toolCallId);
        items.push({ kind: "tool_call", id: tc.toolCallId, tc, turnIndex: turn });
      }
      items.push({
        kind: "assistant",
        id: msg.id,
        content: msg.content,
        createdAt: msg.createdAt,
        toolCount: tcs.length,
        totalToolMs: tcs.reduce((s, t) => s + t.durationMs, 0),
        turnIndex: turn,
      });
    }
  }

  // Pending live tool calls not yet committed to any message
  for (const l of live) {
    if (!committed.has(l.toolCallId)) {
      items.push({
        kind: "tool_call",
        id: l.toolCallId,
        live: true,
        tc: {
          toolCallId: l.toolCallId,
          tool: l.tool,
          input: l.input,
          output: l.output,
          status: l.status,
          pod: l.pod,
          durationMs: l.durationMs,
          queueWaitMs: l.queueWaitMs,
        },
        turnIndex: turn > 0 ? turn : 1,
      });
    }
  }

  return items;
}

// ─── Left panel: timeline item row ───────────────────────────────────────────

function TimelineRow({
  item,
  selected,
  maxMs,
  onClick,
}: {
  item: TraceItem;
  selected: boolean;
  maxMs: number;
  onClick: () => void;
}) {
  const isUser   = item.kind === "user";
  const isAssist = item.kind === "assistant";
  const isTool   = item.kind === "tool_call";

  const durationMs = isTool ? item.tc.durationMs : 0;
  const barPct     = maxMs > 0 ? Math.min(100, (durationMs / maxMs) * 100) : 0;
  const style      = isTool ? toolStyle(item.tc.tool) : null;

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2 rounded-md transition-colors group",
        selected ? "bg-violet-900/20 border border-violet-800/40" : "hover:bg-[#1a1a1a] border border-transparent"
      )}
    >
      <div className="flex items-center gap-2">
        {/* Icon */}
        {isUser && <User size={11} className="text-slate-500 shrink-0" />}
        {isAssist && <Bot size={11} className="text-violet-400 shrink-0" />}
        {isTool && <Terminal size={11} className={cn("shrink-0", style!.text)} />}

        {/* Label */}
        <span className={cn("text-xs truncate flex-1", selected ? "text-slate-200" : "text-slate-400 group-hover:text-slate-200")}>
          {isUser   && "User Prompt"}
          {isAssist && "LLM Response"}
          {isTool   && (
            <span className={cn("font-mono font-medium", style!.text)}>{item.tc.tool}</span>
          )}
          {isTool && item.live && (
            <span className="ml-1.5 text-[9px] text-emerald-400 bg-emerald-900/30 px-1 py-0.5 rounded">live</span>
          )}
        </span>

        {/* Duration */}
        {isTool && (
          <span className="text-[10px] text-slate-600 shrink-0 font-mono">{formatMs(durationMs)}</span>
        )}
        {isUser   && <span className="text-[10px] text-slate-700 shrink-0">—</span>}
        {isAssist && <span className="text-[10px] text-slate-600 shrink-0 font-mono">{formatMs(item.totalToolMs)}</span>}
      </div>

      {/* Duration bar */}
      {isTool && barPct > 0 && (
        <div className="mt-1 h-0.5 bg-[#222] rounded-full overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all", style!.bar)}
            style={{ width: `${barPct}%` }}
          />
        </div>
      )}

      {/* Preview text */}
      {(isUser || isAssist) && (
        <p className="text-[10px] text-slate-600 truncate mt-0.5 pl-[19px]">
          {item.content.slice(0, 80)}
        </p>
      )}
      {isTool && (
        <div className={cn("ml-[19px] mt-0.5 flex items-center gap-1")}>
          {item.tc.status === "completed"
            ? <CheckCircle2 size={9} className="text-emerald-500" />
            : <XCircle size={9} className="text-red-500" />
          }
          {item.tc.pod && (
            <span className="text-[10px] text-slate-700 font-mono">
              {item.tc.pod.replace("sandbox-runner-", "pod-")}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

// ─── Right panel: detail view ─────────────────────────────────────────────────

function DetailPanel({ item }: { item: TraceItem | null }) {
  if (!item) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-700 text-sm">
        Select an item to inspect
      </div>
    );
  }

  if (item.kind === "user") {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        <SectionHeader icon={<User size={13} className="text-slate-400" />} label="User Prompt" />
        <KVRow label="Time" value={formatTime(item.createdAt)} />
        <KVRow label="Words" value={String(item.content.trim().split(/\s+/).length)} />
        <div>
          <FieldLabel>Content</FieldLabel>
          <pre className="bg-[#111] border border-[#2a2a2a] rounded-lg px-4 py-3 text-sm text-slate-200 whitespace-pre-wrap font-sans">
            {item.content}
          </pre>
        </div>
      </div>
    );
  }

  if (item.kind === "assistant") {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        <SectionHeader icon={<Bot size={13} className="text-violet-400" />} label="LLM Response" />
        <div className="grid grid-cols-2 gap-3">
          <KVRow label="Time" value={formatTime(item.createdAt)} />
          <KVRow label="Tool calls" value={String(item.toolCount)} />
          <KVRow label="Total tool time" value={formatMs(item.totalToolMs)} />
          <KVRow label="Words" value={String(item.content.trim().split(/\s+/).length)} />
        </div>
        <div>
          <FieldLabel>Response</FieldLabel>
          <pre className="bg-[#111] border border-[#2a2a2a] rounded-lg px-4 py-3 text-sm text-slate-200 whitespace-pre-wrap font-sans max-h-96 overflow-y-auto">
            {item.content || "(no text response)"}
          </pre>
        </div>
      </div>
    );
  }

  // Tool call
  const { tc, live } = item;
  const style = toolStyle(tc.tool);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <SectionHeader icon={<Terminal size={13} className={style.text} />} label="Tool Call" />
        <span className={cn("px-2 py-0.5 rounded text-[11px] font-semibold font-mono border", style.bg, style.text, "border-current/20")}>
          {tc.tool}
        </span>
        {tc.status === "completed"
          ? <span className="flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-900/20 px-2 py-0.5 rounded"><CheckCircle2 size={10} /> completed</span>
          : <span className="flex items-center gap-1 text-[11px] text-red-400 bg-red-900/20 px-2 py-0.5 rounded"><XCircle size={10} /> failed</span>
        }
        {live && <span className="text-[11px] text-emerald-400 animate-pulse">● live</span>}
      </div>

      {/* Infrastructure */}
      <div>
        <FieldLabel>Infrastructure</FieldLabel>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {[
            { icon: <Server size={11} />, label: "Pod", value: tc.pod?.replace("sandbox-runner-", "pod-") ?? "local" },
            { icon: <Clock size={11} />, label: "Duration", value: formatMs(tc.durationMs) },
            { icon: <Zap size={11} />, label: "Queue wait", value: tc.queueWaitMs != null ? formatMs(tc.queueWaitMs) : "—" },
            { icon: <Hash size={11} />, label: "Tool Call ID", value: tc.toolCallId.slice(0, 12) + "…" },
          ].map(({ icon, label, value }) => (
            <div key={label} className="flex items-start gap-1.5 bg-[#111] border border-[#2a2a2a] rounded-md px-3 py-2">
              <span className="text-slate-600 mt-0.5">{icon}</span>
              <div>
                <div className="text-[10px] text-slate-600">{label}</div>
                <div className="text-xs font-mono text-slate-300">{value}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Input */}
      <div>
        <FieldLabel>Input Parameters</FieldLabel>
        <pre className="bg-[#111] border border-[#2a2a2a] rounded-lg px-4 py-3 text-xs text-slate-300 font-mono whitespace-pre-wrap overflow-x-auto">
          {Object.keys(tc.input ?? {}).length === 0
            ? "(no parameters)"
            : JSON.stringify(tc.input, null, 2)}
        </pre>
      </div>

      {/* Output */}
      <div>
        <FieldLabel>Output</FieldLabel>
        <pre className={cn(
          "bg-[#111] border rounded-lg px-4 py-3 text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto",
          tc.status === "completed" ? "border-[#2a2a2a] text-slate-300" : "border-red-900/40 text-red-300"
        )}>
          {tc.output || "(empty)"}
        </pre>
      </div>
    </div>
  );
}

// ─── Tiny shared components ───────────────────────────────────────────────────

function SectionHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">{label}</span>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-1.5">{children}</div>;
}

function KVRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#111] border border-[#2a2a2a] rounded-md px-3 py-2">
      <div className="text-[10px] text-slate-600">{label}</div>
      <div className="text-xs text-slate-300 font-mono">{value}</div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function TraceDetailPage() {
  const { id: sessionId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveToolCalls, setLiveToolCalls] = useState<ToolCallLiveEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function fetchMessages() {
    if (!sessionId) return;
    fetch(`/chats/${sessionId}`)
      .then((r) => r.json())
      .then((d) => setMessages(d.messages ?? []))
      .catch(() => {});
  }

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    setMessages([]);
    setLiveToolCalls([]);
    setSelectedId(null);
    fetch(`/chats/${sessionId}`)
      .then((r) => r.json())
      .then((d) => {
        const msgs: ChatMessage[] = d.messages ?? [];
        setMessages(msgs);
        // Auto-select first item
        if (msgs.length > 0) setSelectedId(msgs[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId]);

  useWebSocket(useCallback((ev) => {
    if (ev.type === "tool_call_update" && ev.data.sessionId === sessionId) {
      setLiveToolCalls((prev) => {
        const exists = prev.some((t) => t.toolCallId === ev.data.toolCallId);
        if (exists) return prev;
        const next = [...prev, ev.data];
        setSelectedId(ev.data.toolCallId);
        return next;
      });
      setTimeout(fetchMessages, 1500);
    }
    if (ev.type === "execution_update") {
      const d = ev.data as { sessionId?: string };
      if (d.sessionId === sessionId) fetchMessages();
    }
  }, [sessionId]));

  const items = buildItems(messages, liveToolCalls);
  const maxMs = Math.max(1, ...items.filter((i) => i.kind === "tool_call").map((i) => (i as Extract<TraceItem, { kind: "tool_call" }>).tc.durationMs));
  const selected = items.find((i) => i.id === selectedId) ?? null;

  // Stats for header
  const toolItems = items.filter((i): i is Extract<TraceItem, { kind: "tool_call" }> => i.kind === "tool_call");
  const totalMs = toolItems.reduce((s, i) => s + i.tc.durationMs, 0);
  const failCount = toolItems.filter((i) => i.tc.status === "failed").length;

  // Group items by turn for dividers
  let lastTurn = -1;

  if (loading) return (
    <div className="flex-1 bg-[#0d0d0d] flex items-center justify-center text-slate-600 text-sm">
      Loading trace…
    </div>
  );

  if (!loading && messages.length === 0) return (
    <div className="flex-1 bg-[#0d0d0d] flex flex-col items-center justify-center gap-2">
      <Layers size={28} className="text-slate-700" />
      <span className="text-slate-600 text-sm">No messages in this session yet</span>
      <button onClick={() => navigate("/traces")} className="text-violet-400 text-xs hover:text-violet-300 mt-1">
        ← Back
      </button>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0d0d0d]">
      {/* Header bar */}
      <div className="shrink-0 border-b border-[#2a2a2a] px-5 py-3 flex items-center gap-4">
        <button onClick={() => navigate("/traces")} className="text-slate-600 hover:text-slate-300 transition-colors">
          <ArrowLeft size={15} />
        </button>
        <span className="font-mono text-[11px] text-slate-500 truncate max-w-xs">{sessionId}</span>
        <div className="flex items-center gap-3 ml-auto text-[11px]">
          <span className="flex items-center gap-1 text-slate-500">
            <Layers size={11} /> {toolItems.length} tool calls
          </span>
          <span className="flex items-center gap-1 text-slate-500">
            <Clock size={11} /> {formatMs(totalMs)} total
          </span>
          {failCount > 0 && (
            <span className="flex items-center gap-1 text-red-400">
              <XCircle size={11} /> {failCount} failed
            </span>
          )}
        </div>
      </div>

      {/* Split body */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Left: timeline */}
        <div className="w-72 shrink-0 border-r border-[#2a2a2a] overflow-y-auto px-2 py-3 space-y-0.5">
          {items.map((item) => {
            const showDivider = item.turnIndex !== lastTurn;
            if (showDivider) lastTurn = item.turnIndex;
            return (
              <div key={item.id}>
                {showDivider && (
                  <div className="flex items-center gap-2 px-3 pt-3 pb-1">
                    <div className="flex-1 h-px bg-[#2a2a2a]" />
                    <span className="text-[9px] text-slate-700 uppercase tracking-widest">Turn {item.turnIndex}</span>
                    <div className="flex-1 h-px bg-[#2a2a2a]" />
                  </div>
                )}
                <TimelineRow
                  item={item}
                  selected={selectedId === item.id}
                  maxMs={maxMs}
                  onClick={() => setSelectedId(item.id)}
                />
              </div>
            );
          })}
        </div>

        {/* Right: detail */}
        <div className="flex-1 overflow-hidden flex flex-col">
          <DetailPanel item={selected} />
        </div>
      </div>
    </div>
  );
}
