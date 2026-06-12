/**
 * Human-in-the-loop approval flow tests.
 *
 * Tests the full cycle:
 *   chat POST → LLM calls fs_write → WS broadcasts permission_request
 *   → test auto-responds → chat resolves → verify file written (or rejected)
 *
 * Requires: server + worker running (npm run dev + npm run dev:worker)
 */

import { describe, it, expect } from "vitest";
import WebSocket from "ws";

const BASE = "http://localhost:3000";
const WS_URL = "ws://localhost:3000/ws";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function get(path: string) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
}

/**
 * Opens a WS connection, waits for a `permission_request` event, then
 * calls onRequest with the approval payload. Returns when the first
 * permission_request arrives or rejects on timeout.
 */
function waitForApprovalRequest(timeoutMs = 30_000): {
  approvalId: Promise<string>;
  cleanup: () => void;
} {
  let resolve!: (id: string) => void;
  let reject!: (e: Error) => void;

  const approvalId = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const ws = new WebSocket(WS_URL);
  const timer = setTimeout(() => {
    reject(new Error("Timed out waiting for permission_request"));
    ws.close();
  }, timeoutMs);

  ws.on("message", (raw) => {
    try {
      const ev = JSON.parse(raw.toString());
      if (ev.type === "permission_request" && ev.data?.approvalId) {
        clearTimeout(timer);
        resolve(ev.data.approvalId);
      }
    } catch {}
  });

  ws.on("error", (e) => reject(e));

  return {
    approvalId,
    cleanup: () => { clearTimeout(timer); ws.close(); },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("fs_write — human-in-the-loop approval", () => {

  it("approved write: file appears in sandbox after approval", async () => {
    const sessionId = `test-approval-${Date.now()}`;
    const filename = `test-${Date.now()}.txt`;
    const expectedContent = "hello from approval test";

    // 1. Start listening for permission_request BEFORE firing chat
    const { approvalId, cleanup } = waitForApprovalRequest(40_000);

    // 2. Fire chat — this will block until the LLM finishes (which requires approval)
    const chatPromise = post("/chat", {
      sessionId,
      message: `Use fs_write to create a file called "${filename}" with content "${expectedContent}". Do it now.`,
    });

    // 3. Wait for WS to deliver the permission_request
    const id = await approvalId;
    cleanup();
    expect(id).toBeTruthy();

    // 4. Approve the write
    const approveRes = await post(`/approve/${id}`, { approved: true });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.ok).toBe(true);

    // 5. Now the chat can complete
    const chat = await chatPromise;
    expect(chat.status).toBe(200);
    expect(chat.body.message.length).toBeGreaterThan(0);

    // 6. Verify the file exists by reading it back via a second chat
    const readChat = await post("/chat", {
      sessionId: `verify-${Date.now()}`,
      message: `Use fs_read to read the file "${filename}" and tell me its content.`,
    });
    expect(readChat.status).toBe(200);
    expect(readChat.body.message).toContain(expectedContent);
  }, 90_000);

  it("rejected write: agent acknowledges rejection without writing", async () => {
    const sessionId = `test-rejection-${Date.now()}`;
    const filename = `rejected-${Date.now()}.txt`;

    // 1. Listen for permission_request
    const { approvalId, cleanup } = waitForApprovalRequest(40_000);

    // 2. Fire chat
    const chatPromise = post("/chat", {
      sessionId,
      message: `Use fs_write to create "${filename}" with content "should not appear". Do it now.`,
    });

    // 3. Wait for approval request
    const id = await approvalId;
    cleanup();
    expect(id).toBeTruthy();

    // 4. REJECT the write
    const rejectRes = await post(`/approve/${id}`, { approved: false });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.approved).toBe(false);

    // 5. Chat completes — agent should mention rejection
    const chat = await chatPromise;
    expect(chat.status).toBe(200);
    // Agent should acknowledge the rejection
    expect(chat.body.message.length).toBeGreaterThan(0);
    // Tool call should show as failed
    const writeTc = chat.body.toolCalls?.find((tc: { tool: string }) => tc.tool === "fs_write");
    expect(writeTc).toBeDefined();
    expect(writeTc.status).toBe("failed");
  }, 90_000);

  it("approve endpoint returns 404 for unknown approvalId", async () => {
    const res = await post("/approve/nonexistent-id", { approved: true });
    expect(res.status).toBe(404);
  });

  it("approve endpoint returns 400 for missing approved field", async () => {
    const res = await post("/approve/some-id", {});
    expect(res.status).toBe(400);
  });

  it("read then write flow: agent reads file first, then requests write approval", async () => {
    const sessionId = `test-read-write-${Date.now()}`;
    const filename = `rw-${Date.now()}.txt`;

    // 1. First write a file via direct approval so we have something to read
    const { approvalId: firstApproval, cleanup: c1 } = waitForApprovalRequest(40_000);
    const firstWrite = post("/chat", {
      sessionId,
      message: `Use fs_write to create "${filename}" with content "original content". Do it now.`,
    });
    const firstId = await firstApproval;
    c1();
    await post(`/approve/${firstId}`, { approved: true });
    await firstWrite;

    // 2. Now ask agent to read it and then append/overwrite
    const { approvalId: secondApproval, cleanup: c2 } = waitForApprovalRequest(40_000);
    const updateChat = post("/chat", {
      sessionId: `rw2-${Date.now()}`,
      message: `First use fs_read to read "${filename}", then use fs_write to update it with content "updated content".`,
    });

    // Agent should first read (no approval needed), then request write approval
    const secondId = await secondApproval;
    c2();
    expect(secondId).toBeTruthy();

    // Approve the update
    await post(`/approve/${secondId}`, { approved: true });
    const result = await updateChat;
    expect(result.status).toBe(200);

    // Should have both fs_read and fs_write tool calls
    const toolCalls = result.body.toolCalls ?? [];
    const tools = toolCalls.map((tc: { tool: string }) => tc.tool);
    expect(tools).toContain("fs_read");
    expect(tools).toContain("fs_write");
  }, 120_000);
});
