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

      case TOOL_NAMES.FS_WRITE: {
        const filePath = input.filePath as string;
        if (filePath.includes("..") || filePath.startsWith("/")) {
          throw new Error("Path traversal or absolute path rejected");
        }
        const content = (input.content as string).replace(/'/g, "'\\''");
        return ["sh", "-c", `printf '%s' '${content}' > '${SANDBOX_DIR}/${filePath}'`];
      }

      case TOOL_NAMES.ENV_INSPECT: {
        return ["sh", "-c",
          `printf '{"hostname":"%s","user":"%s","workingDirectory":"${SANDBOX_DIR}","podName":"%s","namespace":"%s"}' ` +
          `"$(hostname)" "$(whoami)" "$POD_NAME" "$POD_NAMESPACE"`
        ];
      }

      case TOOL_NAMES.MATH_COMPUTE: {
        const op = input.operation as string;
        const a = Number(input.a ?? 0);
        const b = Number(input.b ?? 0);
        if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("Invalid numeric input");

        let script: string;
        switch (op) {
          case "add":      script = `console.log(${a} + ${b})`; break;
          case "subtract": script = `console.log(${a} - ${b})`; break;
          case "multiply": script = `console.log(${a} * ${b})`; break;
          case "divide":
            if (b === 0) throw new Error("division by zero");
            script = `console.log(${a} / ${b})`;
            break;
          case "modulo":
            if (b === 0) throw new Error("modulo by zero");
            script = `console.log(${a} % ${b})`;
            break;
          case "power":    script = `console.log(Math.pow(${a}, ${b}))`; break;
          case "sqrt":     script = `console.log(Math.sqrt(${a}))`; break;
          case "factorial": {
            const n = Math.floor(a);
            if (n < 0 || n > 1000) throw new Error("factorial: n must be 0–1000");
            script = `let f=1n;for(let i=2n;i<=${n}n;i++)f*=i;console.log(f.toString())`;
            break;
          }
          case "fibonacci": {
            const n = Math.floor(a);
            if (n < 0 || n > 10_000) throw new Error("fibonacci: n must be 0–10000");
            script = `let x=0n,y=1n;for(let i=0;i<${n};i++){let t=x+y;x=y;y=t;}console.log(x.toString())`;
            break;
          }
          case "is_prime": {
            const n = Math.floor(a);
            script = `const n=${n};if(n<2){console.log('false')}else{let p=true;for(let i=2;i<=Math.sqrt(n);i++){if(n%i===0){p=false;break}}console.log(String(p))}`;
            break;
          }
          case "gcd": {
            const x = Math.abs(Math.floor(a)), y = Math.abs(Math.floor(b));
            script = `let x=${x},y=${y};while(y){let t=y;y=x%y;x=t;}console.log(x)`;
            break;
          }
          default:
            throw new Error(`Unknown math operation: ${op}`);
        }

        return ["node", "-e", script];
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
