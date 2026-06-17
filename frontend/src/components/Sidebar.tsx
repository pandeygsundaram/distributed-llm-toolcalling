import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  MessageSquare, Activity, ChevronLeft, ChevronRight,
  Plus, Trash2, LayoutGrid,
} from "lucide-react";
import { cn, formatTime } from "../lib/utils";

interface ChatSession {
  sessionId: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

interface Props {
  currentSessionId: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  refreshTrigger?: number;
}

const NAV_ITEMS = [
  { label: "Chat", icon: MessageSquare, path: "/" },
  { label: "Pods", icon: LayoutGrid, path: "/pods" },
  { label: "Traces", icon: Activity, path: "/traces" },
];

export function Sidebar({ currentSessionId, onNewChat, onSelectSession, refreshTrigger }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    fetch("/chats")
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions ?? []))
      .catch(() => {});
  }, [refreshTrigger, currentSessionId]);

  async function deleteSession(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    await fetch(`/chats/${id}`, { method: "DELETE" });
    setSessions((prev) => prev.filter((s) => s.sessionId !== id));
    if (id === currentSessionId) onNewChat();
  }

  return (
    <aside
      className={cn(
        "relative flex flex-col h-screen bg-[#141414] border-r border-[#2a2a2a] transition-all duration-200 shrink-0",
        collapsed ? "w-12" : "w-56"
      )}
    >
      {/* Toggle button */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="absolute -right-3 top-5 z-10 w-6 h-6 rounded-full bg-[#2a2a2a] border border-[#3a3a3a] flex items-center justify-center text-slate-400 hover:text-white hover:bg-[#333] transition-colors"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>

      {/* Logo */}
      <div className={cn("flex items-center gap-2.5 px-3 py-3.5 border-b border-[#2a2a2a]", collapsed && "justify-center px-0")}>
        <div className="w-6 h-6 rounded bg-violet-600 flex items-center justify-center shrink-0">
          <span className="text-white text-[10px] font-bold">D</span>
        </div>
        {!collapsed && <span className="text-sm font-semibold text-white truncate">distributed-llm</span>}
      </div>

      {/* New Chat */}
      <div className={cn("px-2 py-2 border-b border-[#2a2a2a]", collapsed && "px-1")}>
        <button
          onClick={onNewChat}
          className={cn(
            "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-300 hover:bg-[#222] hover:text-white transition-colors",
            collapsed && "justify-center px-0"
          )}
        >
          <Plus size={15} className="shrink-0 text-violet-400" />
          {!collapsed && <span>New Chat</span>}
        </button>
      </div>

      {/* Nav */}
      <nav className={cn("px-2 py-2 space-y-0.5 border-b border-[#2a2a2a]", collapsed && "px-1")}>
        {NAV_ITEMS.map(({ label, icon: Icon, path }) => {
          const active = location.pathname === path || (path !== "/" && location.pathname.startsWith(path));
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className={cn(
                "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                active
                  ? "bg-violet-600/20 text-violet-300"
                  : "text-slate-400 hover:bg-[#222] hover:text-white",
                collapsed && "justify-center px-0"
              )}
              title={collapsed ? label : undefined}
            >
              <Icon size={15} className="shrink-0" />
              {!collapsed && <span>{label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Previous Chats */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto px-2 py-2 min-h-0">
          <div className="text-[10px] uppercase tracking-widest text-slate-600 px-2 pb-1.5">History</div>
          {sessions.length === 0 && (
            <div className="text-xs text-slate-600 px-2">No chats yet</div>
          )}
          <div className="space-y-0.5">
            {sessions.map((s) => (
              <div
                key={s.sessionId}
                onClick={() => {
                  onSelectSession(s.sessionId);
                  if (location.pathname.startsWith("/traces")) {
                    navigate(`/traces/${s.sessionId}`);
                  } else {
                    navigate("/");
                  }
                }}
                className={cn(
                  "group relative flex flex-col rounded-md px-2 py-1.5 cursor-pointer transition-colors",
                  s.sessionId === currentSessionId
                    ? "bg-[#222] text-white"
                    : "text-slate-400 hover:bg-[#1a1a1a] hover:text-slate-200"
                )}
              >
                <span className="text-xs truncate pr-5">{s.title || "Untitled"}</span>
                <span className="text-[10px] text-slate-600">{formatTime(s.lastMessageAt)}</span>
                <button
                  onClick={(e) => deleteSession(e, s.sessionId)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-red-400 transition-all"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
