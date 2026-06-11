import os from "os";
import process from "process";

export interface EnvInspectOutput {
  hostname: string;
  user: string;
  workingDirectory: string;
  platform: string;
  nodeVersion: string;
  uptime: number;
  memoryMB: {
    total: number;
    free: number;
  };
  // Populated in Phase 2 when running inside a pod
  podName?: string;
  namespace?: string;
}

export async function envInspect(sandboxDir: string): Promise<EnvInspectOutput> {
  return {
    hostname: os.hostname(),
    user: os.userInfo().username,
    workingDirectory: sandboxDir,
    platform: process.platform,
    nodeVersion: process.version,
    uptime: Math.floor(process.uptime()),
    memoryMB: {
      total: Math.round(os.totalmem() / 1024 / 1024),
      free: Math.round(os.freemem() / 1024 / 1024),
    },
    podName: process.env.POD_NAME,
    namespace: process.env.POD_NAMESPACE,
  };
}

export const envInspectDefinition = {
  name: "env_inspect",
  description: "Returns runtime environment information: hostname, user, working directory, Node.js version, memory, and pod metadata when running in Kubernetes.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};
