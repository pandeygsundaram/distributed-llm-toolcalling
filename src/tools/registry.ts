import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";
import { shellRunDefinition } from "./shell-run.js";
import { fsReadDefinition } from "./fs-read.js";
import { envInspectDefinition } from "./env-inspect.js";

export const toolDefinitions: Tool[] = [
  shellRunDefinition,
  fsReadDefinition,
  envInspectDefinition,
];

export const TOOL_NAMES = {
  SHELL_RUN: "shell_run",
  FS_READ: "fs_read",
  ENV_INSPECT: "env_inspect",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
