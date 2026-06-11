import * as k8s from "@kubernetes/client-node";
import { config } from "../config.js";
import { logger } from "../logger.js";

// Kubernetes MicroTime requires 6 decimal places (microseconds), not 3 (milliseconds)
function microTime(): string {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
}

const POD_NAMES = Array.from({ length: 8 }, (_, i) => `sandbox-runner-${i}`);

export interface LeaseContext {
  instanceId: string;
  requestId: string;
  sessionId: string;
  toolCallId: string;
}

interface Waiter {
  context: LeaseContext;
  resolve: (podName: string) => void;
  reject: (err: Error) => void;
  enqueueTime: number;
}

export class LeaseManager {
  private readonly coordApi: k8s.CoordinationV1Api;
  private readonly namespace: string;
  private readonly leaseTtlSeconds: number;
  private readonly maxWaitMs: number;
  private readonly waiters: Waiter[] = [];

  constructor() {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    this.coordApi = kc.makeApiClient(k8s.CoordinationV1Api);
    this.namespace = config.K8S_NAMESPACE;
    this.leaseTtlSeconds = config.LEASE_TTL_SECONDS;
    this.maxWaitMs = config.QUEUE_MAX_WAIT_MS;
  }

  // Try all pods; if all busy, enqueue and wait up to maxWaitMs
  async acquirePod(context: LeaseContext): Promise<string> {
    logger.info({ ...context }, "sandbox.lease.acquire.attempted");

    const pod = await this.tryAcquireAny(context);
    if (pod) return pod;

    logger.info({ ...context, queueDepth: this.waiters.length }, "sandbox.queue.wait.started");

    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = { context, resolve, reject, enqueueTime: Date.now() };
      this.waiters.push(waiter);

      setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx === -1) return; // already dequeued
        this.waiters.splice(idx, 1);
        logger.warn({ ...context, waitMs: Date.now() - waiter.enqueueTime }, "sandbox.queue.wait.timeout");
        reject(new QueueTimeoutError());
      }, this.maxWaitMs);
    });
  }

  async releasePod(podName: string): Promise<void> {
    await this.clearLease(podName);
    logger.info({ pod: podName }, "sandbox.lease.released");

    // Hand pod to next waiter if any
    const waiter = this.waiters.shift();
    if (!waiter) return;

    const waitMs = Date.now() - waiter.enqueueTime;
    logger.info({ ...waiter.context, waitMs, pod: podName }, "sandbox.queue.wait.completed");

    try {
      await this.acquireLease(podName, waiter.context);
      waiter.resolve(podName);
    } catch {
      // Lease conflict on this pod — put waiter back at front and try others
      this.waiters.unshift(waiter);
      const retry = await this.tryAcquireAny(waiter.context);
      if (retry) {
        this.waiters.shift();
        waiter.resolve(retry);
      }
      // If still nothing, waiter stays in queue until next release or timeout
    }
  }

  // Returns current state of all leases for /pods endpoint
  async listLeaseStates(): Promise<PodLeaseState[]> {
    const states: PodLeaseState[] = [];
    for (const podName of POD_NAMES) {
      try {
        const lease = await this.coordApi.readNamespacedLease({ name: podName, namespace: this.namespace });
        const spec = lease.spec ?? {};
        const isLeased = !!spec.holderIdentity && !this.isExpired(spec);
        states.push({
          name: podName,
          lease: isLeased
            ? {
                status: "leased",
                holderIdentity: spec.holderIdentity!,
                expiresAt: this.expiresAt(spec),
              }
            : { status: "free" },
        });
      } catch {
        states.push({ name: podName, lease: { status: "unknown" } });
      }
    }
    return states;
  }

  private async tryAcquireAny(context: LeaseContext): Promise<string | null> {
    // Shuffle to distribute load rather than always hammering pod-0
    const pods = [...POD_NAMES].sort(() => Math.random() - 0.5);
    for (const podName of pods) {
      const acquired = await this.tryAcquireLease(podName, context);
      if (acquired) return podName;
    }
    return null;
  }

  private async tryAcquireLease(podName: string, context: LeaseContext): Promise<boolean> {
    try {
      const lease = await this.coordApi.readNamespacedLease({ name: podName, namespace: this.namespace });
      const spec = lease.spec ?? {};

      // Pod is busy if holder exists and lease hasn't expired
      if (spec.holderIdentity && !this.isExpired(spec)) return false;

      if (spec.holderIdentity) {
        logger.info({ pod: podName, expiredHolder: spec.holderIdentity }, "sandbox.lease.expired-recovery");
      }

      await this.acquireLease(podName, context, lease.metadata?.resourceVersion);
      return true;
    } catch (err: unknown) {
      const e = err as { statusCode?: number; body?: { code?: number }; message?: string };
      const code = e.statusCode ?? e.body?.code;
      if (code === 409) {
        logger.debug({ pod: podName, ...context }, "sandbox.lease.conflict");
      } else {
        logger.error({ pod: podName, code, error: e.message }, "sandbox.lease.acquire-error");
      }
      return false;
    }
  }

  private async acquireLease(podName: string, context: LeaseContext, resourceVersion?: string): Promise<void> {
    const holderIdentity = `${context.instanceId}:${context.requestId}:${context.sessionId}:${context.toolCallId}`;
    const now = microTime();

    await this.coordApi.replaceNamespacedLease({
      name: podName,
      namespace: this.namespace,
      body: {
        apiVersion: "coordination.k8s.io/v1",
        kind: "Lease",
        metadata: {
          name: podName,
          namespace: this.namespace,
          resourceVersion,
        },
        spec: {
          holderIdentity,
          leaseDurationSeconds: this.leaseTtlSeconds,
          renewTime: now as unknown as Date,
          acquireTime: now as unknown as Date,
        },
      },
    });

    logger.info({ pod: podName, holderIdentity, leaseDurationSeconds: this.leaseTtlSeconds }, "sandbox.lease.acquired");
  }

  private async clearLease(podName: string): Promise<void> {
    try {
      const lease = await this.coordApi.readNamespacedLease({ name: podName, namespace: this.namespace });
      await this.coordApi.replaceNamespacedLease({
        name: podName,
        namespace: this.namespace,
        body: {
          apiVersion: "coordination.k8s.io/v1",
          kind: "Lease",
          metadata: {
            name: podName,
            namespace: this.namespace,
            resourceVersion: lease.metadata?.resourceVersion,
          },
          spec: {
            holderIdentity: "",
            leaseDurationSeconds: this.leaseTtlSeconds,
            renewTime: microTime() as unknown as Date,
          },
        },
      });
    } catch (err) {
      logger.warn({ pod: podName, err }, "sandbox.lease.release-failed (non-fatal)");
    }
  }

  private isExpired(spec: k8s.V1LeaseSpec): boolean {
    if (!spec.renewTime || !spec.leaseDurationSeconds) return true;
    const renewedAt = new Date(spec.renewTime as unknown as string).getTime();
    return Date.now() > renewedAt + spec.leaseDurationSeconds * 1000;
  }

  private expiresAt(spec: k8s.V1LeaseSpec): string {
    if (!spec.renewTime || !spec.leaseDurationSeconds) return "unknown";
    const renewedAt = new Date(spec.renewTime as unknown as string).getTime();
    return new Date(renewedAt + spec.leaseDurationSeconds * 1000).toISOString();
  }
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
