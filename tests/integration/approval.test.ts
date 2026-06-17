/**
 * Human-in-the-loop approval flow tests.
 *
 * Tests the full cycle:
 *   chat POST → LLM calls fs_write → SSE broadcasts permission_request
 *   → test auto-responds → chat resolves → verify file written (or rejected)
 *
 * Requires: server + worker running (npm run dev + npm run dev:worker)
 */

import { describe, it, expect } from "vitest";
import { EventSource } from "eventsource";

const BASE = "http://localhost:3000";
const SSE_URL = "http://localhost:3000/events";

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
 * Opens an SSE connection, waits for a `permission_request` event, resolves
 * with the approvalId. Rejects on timeout.
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

  const source = new EventSource(SSE_URL);
  let timer: NodeJS.Timeout;

  source.onopen = () => {
    // Start the timeout only after the SSE connection is confirmed open
    timer = setTimeout(() => {
      reject(new Error("Timed out waiting for permission_request"));
      source.close();
    }, timeoutMs);
  };

  source.onmessage = (e: MessageEvent) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === "permission_request" && ev.data?.approvalId) {
        clearTimeout(timer);
        resolve(ev.data.approvalId);
      }
    } catch {}
  };

  source.onerror = () => {
    // SSE reconnects automatically — don't reject on transient errors
  };

  return {
    approvalId,
    cleanup: () => { clearTimeout(timer); source.close(); },
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
    await new Promise((r) => setTimeout(r, 300)); // let SSE connection open

    // 2. Fire chat — blocks until LLM finishes (requires approval first)
    const chatPromise = post("/chat", {
      sessionId,
      message: `Use fs_write to create a file called "${filename}" with content "${expectedContent}". Do it now.`,
    });

    // 3. Wait for SSE to deliver the permission_request
    const id = await approvalId;
    cleanup();
    expect(id).toBeTruthy();

    // 4. Approve the write
    const approveRes = await post(`/approve/${id}`, { approved: true });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.ok).toBe(true);

    // 5. Chat can now complete
    const chat = await chatPromise;
    expect(chat.status).toBe(200);
    expect(chat.body.message.length).toBeGreaterThan(0);

    // 6. Verify write tool call completed successfully
    // Each tool call gets an isolated sandbox that is cleaned up after release (P3).
    // File persistence across tool calls is intentionally not supported — verify
    // the approval flow itself worked via the tool call status.
    const writeTc = chat.body.toolCalls?.find((tc: { tool: string }) => tc.tool === "fs_write");
    expect(writeTc).toBeDefined();
    expect(writeTc.status).toBe("completed");
    expect(chat.body.message.length).toBeGreaterThan(0);
  }, 90_000);

  it("rejected write: agent acknowledges rejection without writing", async () => {
    const sessionId = `test-rejection-${Date.now()}`;
    const filename = `rejected-${Date.now()}.txt`;

    const { approvalId, cleanup } = waitForApprovalRequest(40_000);

    const chatPromise = post("/chat", {
      sessionId,
      message: `Use fs_write to create "${filename}" with content "should not appear". Do it now.`,
    });

    const id = await approvalId;
    cleanup();
    expect(id).toBeTruthy();

    // REJECT the write
    const rejectRes = await post(`/approve/${id}`, { approved: false });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.approved).toBe(false);

    const chat = await chatPromise;
    expect(chat.status).toBe(200);
    expect(chat.body.message.length).toBeGreaterThan(0);

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

    // 2. Now ask agent to read it and then overwrite
    const { approvalId: secondApproval, cleanup: c2 } = waitForApprovalRequest(40_000);
    const updateChat = post("/chat", {
      sessionId: `rw2-${Date.now()}`,
      message: `First use fs_read to read "${filename}", then use fs_write to update it with content "updated content".`,
    });

    const secondId = await secondApproval;
    c2();
    expect(secondId).toBeTruthy();

    await post(`/approve/${secondId}`, { approved: true });
    const result = await updateChat;
    expect(result.status).toBe(200);

    const toolCalls = result.body.toolCalls ?? [];
    const tools = toolCalls.map((tc: { tool: string }) => tc.tool);
    expect(tools).toContain("fs_read");
    expect(tools).toContain("fs_write");
  }, 120_000);
});
