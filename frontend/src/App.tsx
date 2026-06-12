import { useState, useCallback } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { ChatPage } from "./pages/ChatPage";
import { PodsPage } from "./pages/PodsPage";
import { TracesPage } from "./pages/TracesPage";
import { TraceDetailPage } from "./pages/TraceDetailPage";
import { ApprovalModal, type ApprovalRequest } from "./components/ApprovalModal";
import { useWebSocket } from "./hooks/useWebSocket";

function newSessionId() {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export default function App() {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const navigate = useNavigate();

  // Global WS listener for permission_request — works regardless of which page is open
  useWebSocket(useCallback((ev) => {
    if (ev.type === "permission_request") {
      setPendingApproval(ev.data as ApprovalRequest);
    }
  }, []));

  async function handleApprovalResponse(approvalId: string, approved: boolean) {
    setPendingApproval(null);
    await fetch(`/approve/${approvalId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
  }

  const handleNewChat = useCallback(() => {
    setSessionId(newSessionId());
    navigate("/");
  }, [navigate]);

  const handleSelectSession = useCallback((id: string) => {
    setSessionId(id);
  }, []);

  const handleMessageSent = useCallback(() => {
    setSidebarRefresh((n) => n + 1);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-[#0d0d0d]">
      <Sidebar
        currentSessionId={sessionId}
        onNewChat={handleNewChat}
        onSelectSession={handleSelectSession}
        refreshTrigger={sidebarRefresh}
      />

      <main className="flex flex-1 overflow-hidden min-w-0">
        <Routes>
          <Route
            path="/"
            element={
              <ChatPage
                sessionId={sessionId}
                onMessageSent={handleMessageSent}
              />
            }
          />
          <Route path="/pods" element={<PodsPage />} />
          <Route path="/traces" element={<TracesPage />} />
          <Route path="/traces/:id" element={<TraceDetailPage />} />
        </Routes>
      </main>

      {/* Global approval modal — renders over everything */}
      {pendingApproval && (
        <ApprovalModal
          request={pendingApproval}
          onRespond={handleApprovalResponse}
        />
      )}
    </div>
  );
}
