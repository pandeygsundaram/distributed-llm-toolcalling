import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { shellRun } from "../../src/tools/shell-run.js";
import { fsRead } from "../../src/tools/fs-read.js";
import { envInspect } from "../../src/tools/env-inspect.js";

let sandboxDir: string;

beforeAll(async () => {
  sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendai-test-"));
  await fs.writeFile(path.join(sandboxDir, "hello.txt"), "hello world");
});

describe("shell.run", () => {
  it("runs pwd", async () => {
    const out = await shellRun({ command: "pwd" }, sandboxDir);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(sandboxDir);
  });

  it("runs ls", async () => {
    const out = await shellRun({ command: "ls" }, sandboxDir);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("hello.txt");
  });

  it("runs whoami", async () => {
    const out = await shellRun({ command: "whoami" }, sandboxDir);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.length).toBeGreaterThan(0);
  });

  it("rejects disallowed command", async () => {
    await expect(shellRun({ command: "rm" as never }, sandboxDir)).rejects.toThrow("not allowed");
  });

  it("rejects dangerous args for ls", async () => {
    await expect(shellRun({ command: "ls", args: ["--recursive"] }, sandboxDir)).rejects.toThrow("Invalid arguments");
  });
});

describe("fs.read", () => {
  it("reads a file", async () => {
    const out = await fsRead({ filePath: "hello.txt" }, sandboxDir);
    expect(out.content).toBe("hello world");
    expect(out.sizeBytes).toBe(11);
  });

  it("rejects absolute path", async () => {
    await expect(fsRead({ filePath: "/etc/passwd" }, sandboxDir)).rejects.toThrow("Absolute paths");
  });

  it("rejects path traversal", async () => {
    await expect(fsRead({ filePath: "../../etc/passwd" }, sandboxDir)).rejects.toThrow("traversal");
  });

  it("rejects missing file", async () => {
    await expect(fsRead({ filePath: "does-not-exist.txt" }, sandboxDir)).rejects.toThrow("not found");
  });
});

describe("env.inspect", () => {
  it("returns runtime info", async () => {
    const out = await envInspect(sandboxDir);
    expect(out.nodeVersion).toMatch(/^v\d+/);
    expect(out.workingDirectory).toBe(sandboxDir);
    expect(out.platform).toBeTruthy();
    expect(out.memoryMB.total).toBeGreaterThan(0);
  });
});
