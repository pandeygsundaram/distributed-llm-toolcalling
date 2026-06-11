import * as k8s from "@kubernetes/client-node";
import { Writable } from "stream";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { TOOL_NAMES } from "../tools/registry.js";

const SANDBOX_DIR = "/sandbox";
const CONTAINER = "sandbox";

export interface PodToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class PodExecutor {
  private readonly exec: k8s.Exec;
  private readonly namespace: string;

  constructor() {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    this.exec = new k8s.Exec(kc);
    this.namespace = config.K8S_NAMESPACE;
  }

  async run(
    podName: string,
    tool: string,
    input: Record<string, unknown>,
    timeoutMs = config.TOOL_TIMEOUT_MS
  ): Promise<PodToolResult> {
    const command = this.buildCommand(tool, input);

    logger.info({ pod: podName, tool, command }, "tool.pod.execution.started");

    const result = await Promise.race([
      this.execInPod(podName, command),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`tool execution timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);

    return result;
  }

  private buildCommand(tool: string, input: Record<string, unknown>): string[] {
    switch (tool) {
      case TOOL_NAMES.SHELL_RUN: {
        const cmd = input.command as string;
        const args = (input.args as string[] | undefined) ?? [];
        const safeArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
        const full = safeArgs ? `${cmd} ${safeArgs}` : cmd;
        return ["sh", "-c", `cd ${SANDBOX_DIR} && ${full}`];
      }

      case TOOL_NAMES.FS_READ: {
        const filePath = input.filePath as string;
        if (filePath.includes("..") || filePath.startsWith("/")) {
          throw new Error("Path traversal or absolute path rejected");
        }
        return ["sh", "-c", `cat '${SANDBOX_DIR}/${filePath}'`];
      }

      case TOOL_NAMES.ENV_INSPECT: {
        return ["sh", "-c",
          `printf '{"hostname":"%s","user":"%s","workingDirectory":"${SANDBOX_DIR}","podName":"%s","namespace":"%s"}' ` +
          `"$(hostname)" "$(whoami)" "$POD_NAME" "$POD_NAMESPACE"`
        ];
      }

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  private execInPod(podName: string, command: string[]): Promise<PodToolResult> {
    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const stdout = new Writable({
        write(chunk, _enc, cb) { stdoutChunks.push(Buffer.from(chunk)); cb(); },
      });
      const stderr = new Writable({
        write(chunk, _enc, cb) { stderrChunks.push(Buffer.from(chunk)); cb(); },
      });

      this.exec
        .exec(
          this.namespace,
          podName,
          CONTAINER,
          command,
          stdout,
          stderr,
          null,
          false,
          (status: k8s.V1Status) => {
            const out = Buffer.concat(stdoutChunks).toString("utf-8").trim();
            const err = Buffer.concat(stderrChunks).toString("utf-8").trim();
            const exitCode = status.status === "Success" ? 0 : 1;
            resolve({ stdout: out, stderr: err, exitCode });
          }
        )
        .catch(reject);
    });
  }
}

// Shell variable references used inside the pod
const POD_NAME_VAR = '"$POD_NAME"';
const NS_VAR = '"$POD_NAMESPACE"';
