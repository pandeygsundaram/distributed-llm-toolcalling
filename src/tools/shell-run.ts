import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

const ALLOWED_COMMANDS = ["pwd", "ls", "cat", "node", "whoami"] as const;
type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

const ALLOWED_ARGS: Record<AllowedCommand, (args: string[]) => boolean> = {
  pwd: (args) => args.length === 0,
  ls: (args) => args.every((a) => !a.startsWith("-") || ["-l", "-a", "-la", "-al"].includes(a)),
  cat: (args) => args.length === 1 && !args[0].includes(".."),
  node: (args) => args.length === 1 && args[0] === "--version",
  whoami: (args) => args.length === 0,
};

export interface ShellRunInput {
  command: string;
  args?: string[];
}

export interface ShellRunOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function shellRun(
  input: ShellRunInput,
  sandboxDir: string
): Promise<ShellRunOutput> {
  const cmd = input.command as AllowedCommand;
  const args = input.args ?? [];

  if (!ALLOWED_COMMANDS.includes(cmd)) {
    throw new Error(`Command not allowed: ${input.command}. Allowed: ${ALLOWED_COMMANDS.join(", ")}`);
  }

  if (!ALLOWED_ARGS[cmd](args)) {
    throw new Error(`Invalid arguments for ${cmd}: ${JSON.stringify(args)}`);
  }

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: sandboxDir,
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sandboxDir },
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout?.trim() ?? "",
      stderr: e.stderr?.trim() ?? String(err),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export const shellRunDefinition = {
  name: "shell_run",
  description: "Run an allowlisted shell command inside the sandbox. Allowed commands: pwd, ls, cat, node --version, whoami.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        enum: [...ALLOWED_COMMANDS],
        description: "The command to run.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass to the command.",
      },
    },
    required: ["command"],
  },
};
