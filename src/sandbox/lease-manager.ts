import * as k8s from "@kubernetes/client-node";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getLockClient, POD_LOCK_KEY } from "../queue/redis-client.js";
import type { Redis } from "ioredis";

export interface LeaseContext {
  instanceId: string;
  requestId: string;
  sessionId: string;
  toolCallId: string;
}

interface Waiter {
  context: LeaseContext;
  resolve: (pod: string, queuePosition: number, waitMs: number) => void;
  reject: (err: Error) => void;
  enqueueTime: number;
}

export interface AcquireResult {
  pod: string;
  queuePosition: number;
  waitMs: number;
}

export interface PodLeaseState {
  name: string;
  lease:
    | { status: "free" }
    | { status: "leased"; holderIdentity: string; expiresAt: string }
    | { status: "unknown" };
}

export class QueueTimeoutError extends Error {
  readonly code = "sandbox_capacity_timeout";
  constructor() {
    super("No sandbox pod became available within 15 seconds.");
    this.name = "QueueTimeoutError";
  }
}

export class LeaseManager {
  private readonly coreApi: k8s.CoreV1Api;
  private readonly lockClient: Redis;
  private readonly namespace: string;
  private readonly leaseTtlMs: number;
  private readonly maxWaitMs: number;
  private readonly waiters: Waiter[] = [];

  // Starts with static fallback; overwritten by K8s discovery every 10s
  private podNames: string[] = Array.from({ length: 8 }, (_, i) => `sandbox-runner-${i}`);

  private discoveryInterval?: NodeJS.Timeout;
  private watchdogInterval?: NodeJS.Timeout;

  constructor() {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.lockClient = getLockClient();
    this.namespace = config.K8S_NAMESPACE;
    this.leaseTtlMs = config.LEASE_TTL_SECONDS * 1000;
    this.maxWaitMs = config.QUEUE_MAX_WAIT_MS;
    this.startPodDiscovery();
    this.startWatchdog();
  }

  queueInfo(): { depth: number; estimatedWaitMs: number } {
    const avgToolMs = 3000;
    return { depth: this.waiters.length, estimatedWaitMs: this.waiters.length * avgToolMs };
  }

  get queueDepth(): number {
    return this.waiters.length;
  }

  async acquirePod(context: LeaseContext): Promise<AcquireResult> {
    logger.info({ ...context }, "sandbox.lock.acquire.attempted");

    const pod = await this.tryAcquireAny(context);
    if (pod) return { pod, queuePosition: 0, waitMs: 0 };

    logger.info({ ...context, queueDepth: this.waiters.length }, "sandbox.queue.wait.started");

    return new Promise<AcquireResult>((resolve, reject) => {
      const waiter: Waiter = {
        context,
        resolve: (p, queuePosition, waitMs) => resolve({ pod: p, queuePosition, waitMs }),
        reject,
        enqueueTime: Date.now(),
      };
      this.waiters.push(waiter);

      setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx === -1) return;
        this.waiters.splice(idx, 1);
        logger.warn({ ...context, waitMs: Date.now() - waiter.enqueueTime }, "sandbox.queue.wait.timeout");
        reject(new QueueTimeoutError());
      }, this.maxWaitMs);
    });
  }

  // Renew the Redis TTL for a held pod — called by the worker heartbeat every LEASE_TTL/3
  async renewLease(podName: string): Promise<void> {
    const result = await this.lockClient.pexpire(POD_LOCK_KEY(podName), this.leaseTtlMs);
    if (result === 0) {
      logger.warn({ pod: podName }, "sandbox.lock.renew.key-missing — lock already expired");
    }
  }

  async releasePod(podName: string): Promise<void> {
    await this.lockClient.del(POD_LOCK_KEY(podName));

    const waiter = this.waiters.shift();
    if (!waiter) {
      logger.info({ pod: podName }, "sandbox.lock.released");
      return;
    }

    const waitMs = Date.now() - waiter.enqueueTime;
    const acquired = await this.tryAcquirePod(podName, waiter.context);
    if (acquired) {
      logger.info({ pod: podName, ...waiter.context, waitMs }, "sandbox.queue.wait.completed");
      waiter.resolve(podName, 1, waitMs);
    } else {
      // Another worker grabbed this pod first — put waiter back and try any available pod
      this.waiters.unshift(waiter);
      const pod = await this.tryAcquireAny(waiter.context);
      if (pod) {
        this.waiters.shift();
        waiter.resolve(pod, 1, waitMs);
      }
    }
  }

  async listLeaseStates(): Promise<PodLeaseState[]> {
    const states: PodLeaseState[] = [];
    for (const podName of this.podNames) {
      try {
        const holder = await this.lockClient.get(POD_LOCK_KEY(podName));
        if (holder) {
          const ttlMs = await this.lockClient.pttl(POD_LOCK_KEY(podName));
          const expiresAt = new Date(Date.now() + Math.max(0, ttlMs)).toISOString();
          states.push({ name: podName, lease: { status: "leased", holderIdentity: holder, expiresAt } });
        } else {
          states.push({ name: podName, lease: { status: "free" } });
        }
      } catch {
        states.push({ name: podName, lease: { status: "unknown" } });
      }
    }
    return states;
  }

  async annotatePod(podName: string, toolCallId: string): Promise<void> {
    try {
      await Promise.race([
        this.coreApi.patchNamespacedPod({
          name: podName,
          namespace: this.namespace,
          body: {
            metadata: {
              annotations: {
                "sandbox.ai/current-tool-id": toolCallId,
                "sandbox.ai/tool-started-at": new Date().toISOString(),
              },
            },
          },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("annotate timeout")), 3_000)),
      ]);
    } catch {
      // non-fatal
    }
  }

  async clearAnnotations(podName: string): Promise<void> {
    try {
      await Promise.race([
        this.coreApi.patchNamespacedPod({
          name: podName,
          namespace: this.namespace,
          body: {
            metadata: {
              annotations: {
                "sandbox.ai/current-tool-id": null,
                "sandbox.ai/tool-started-at": null,
              },
            },
          },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("clear-annotations timeout")), 3_000)),
      ]);
    } catch {
      // non-fatal
    }
  }

  stopWatchdog() {
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.discoveryInterval) clearInterval(this.discoveryInterval);
  }

  private async tryAcquireAny(context: LeaseContext): Promise<string | null> {
    for (const podName of this.podNames) {
      if (await this.tryAcquirePod(podName, context)) return podName;
    }
    return null;
  }

  private async tryAcquirePod(podName: string, context: LeaseContext): Promise<boolean> {
    const holder = `${context.instanceId}:${context.toolCallId}`;
    const res = await this.lockClient.set(
      POD_LOCK_KEY(podName),
      holder,
      "PX",
      this.leaseTtlMs,
      "NX",
    );
    if (res === "OK") {
      logger.info({ pod: podName, holder, ttlMs: this.leaseTtlMs }, "sandbox.lock.acquired");
      return true;
    }
    return false;
  }

  private startPodDiscovery() {
    const discover = async () => {
      try {
        const res = await this.coreApi.listNamespacedPod({
          namespace: this.namespace,
          labelSelector: "app=sandbox-runner",
          fieldSelector: "status.phase=Running",
        });
        const names = (res.items ?? [])
          .map((p) => p.metadata?.name ?? "")
          .filter(Boolean)
          .sort();
        if (names.length > 0) {
          this.podNames = names;
          logger.debug({ pods: names }, "sandbox.pod.discovery.updated");
        }
      } catch (err) {
        logger.warn({ err }, "sandbox.pod.discovery.failed — retaining last known list");
      }
    };

    discover();
    this.discoveryInterval = setInterval(discover, config.POD_DISCOVERY_INTERVAL_MS);
    this.discoveryInterval.unref();
  }

  // Periodically try to assign waiting requests to any pods freed by TTL expiry
  private startWatchdog() {
    this.watchdogInterval = setInterval(async () => {
      if (this.waiters.length === 0) return;
      const waiter = this.waiters[0];
      const pod = await this.tryAcquireAny(waiter.context);
      if (pod) {
        this.waiters.shift();
        const waitMs = Date.now() - waiter.enqueueTime;
        logger.info({ pod, waitMs }, "sandbox.watchdog.assigned-waiter");
        waiter.resolve(pod, 1, waitMs);
      }
    }, 5_000);
    this.watchdogInterval.unref();
  }
}
