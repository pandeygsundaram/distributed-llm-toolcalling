import { useEffect, useRef, useCallback } from "react";

export interface ToolCallLiveEvent {
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  status: "completed" | "failed";
  executedIn: "local" | "pod";
  pod?: string;
  durationMs: number;
  sessionId: string;
  requestId: string;
  queuePosition?: number;
  queueWaitMs?: number;
}

export type WSEvent =
  | { type: "pods_update"; data: { pods: PodState[] } }
  | { type: "metrics_update"; data: MetricsSnapshot }
  | { type: "execution_update"; data: ExecutionRecord }
  | { type: "tool_call_update"; data: ToolCallLiveEvent }
  | { type: "queue_update"; data: { depth: number; waiters: number } }
  | { type: "permission_request"; data: unknown };

export interface PodState {
  name: string;
  lease:
    | { status: "free" }
    | { status: "leased"; holderIdentity: string; expiresAt: string }
    | { status: "unknown" };
}

export interface ToolStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  totalMs: number;
}

export interface MetricsSnapshot {
  window: string;
  queueDepth: number;
  podsInUse: number;
  queueWait: { count: number; p50: number; p95: number; p99: number; avg: number };
  leaseAcquire: { count: number; p50: number; p95: number; p99: number; avg: number };
  tools: Record<string, ToolStats>;
  generatedAt: string;
}

export interface ExecutionRecord {
  id: string;
  requestId: string;
  sessionId: string;
  tool: string;
  pod: string;
  status: "completed" | "failed";
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

export function useWebSocket(onEvent: (ev: WSEvent) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let ws: WebSocket;
    let dead = false;

    function connect() {
      if (dead) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (e) => {
        try { onEventRef.current(JSON.parse(e.data)); } catch {}
      };
      ws.onclose = () => { if (!dead) setTimeout(connect, 2000); };
    }

    connect();
    return () => { dead = true; ws?.close(); };
  }, []);
}
