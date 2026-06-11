import fs from "fs/promises";
import path from "path";

export interface FsReadInput {
  filePath: string;
}

export interface FsReadOutput {
  content: string;
  sizeBytes: number;
}

const MAX_FILE_SIZE = 100 * 1024; // 100 KB

export async function fsRead(
  input: FsReadInput,
  sandboxDir: string
): Promise<FsReadOutput> {
  if (path.isAbsolute(input.filePath)) {
    throw new Error("Absolute paths are not allowed. Use a relative path within the sandbox.");
  }

  const resolved = path.resolve(sandboxDir, input.filePath);

  if (!resolved.startsWith(path.resolve(sandboxDir))) {
    throw new Error("Path traversal detected. Access denied.");
  }

  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`File not found: ${input.filePath}`);
  if (!stat.isFile()) throw new Error(`Not a file: ${input.filePath}`);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`);
  }

  const content = await fs.readFile(resolved, "utf-8");
  return { content, sizeBytes: stat.size };
}

export const fsReadDefinition = {
  name: "fs_read",
  description: "Read a file from the sandbox directory. Only relative paths within the sandbox are allowed.",
  input_schema: {
    type: "object" as const,
    properties: {
      filePath: {
        type: "string",
        description: "Relative path to the file within the sandbox (e.g. 'src/index.ts').",
      },
    },
    required: ["filePath"],
  },
};
