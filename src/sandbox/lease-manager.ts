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
  resolve: (pod: string, queuePosition: number, waitMs: number) => void;
  reject: (err: Error) => void;
  enqueueTime: number;
}

export interface AcquireResult {
  pod: string;
  queuePosition: number;  // 0 = got pod immediately, >0 = waited N positions
  waitMs: number;
}

export class LeaseManager {
  private readonly coordApi: k8s.CoordinationV1Api;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly namespace: string;
  private readonly leaseTtlSeconds: number;
  private readonly maxWaitMs: number;
  private readonly waiters: Waiter[] = [];
  // Optimistic in-process reservation — prevents concurrent jobs from racing on the
  // same pod and generating K8s 409s. Node.js is single-threaded so the has+add below
  // is atomic; the K8s lease remains the authoritative lock for multi-replica safety.
  private readonly inMemoryHeld = new Set<string>();
  private watchdogInterval?: NodeJS.Timeout;

  constructor() {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    this.coordApi = kc.makeApiClient(k8s.CoordinationV1Api);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.namespace = config.K8S_NAMESPACE;
    this.leaseTtlSeconds = config.LEASE_TTL_SECONDS;
    this.maxWaitMs = config.QUEUE_MAX_WAIT_MS;
    this.startWatchdog();
  }

  // Returns queue depth + estimated wait for callers that want to show it before queuing
  queueInfo(): { depth: number; estimatedWaitMs: number } {
    const avgToolMs = 3000; // conservative avg tool exec time
    return { depth: this.waiters.length, estimatedWaitMs: this.waiters.length * avgToolMs };
  }

  // Try all pods; if all busy, enqueue and wait up to maxWaitMs
  async acquirePod(context: LeaseContext): Promise<AcquireResult> {
    logger.info({ ...context }, "sandbox.lease.acquire.attempted");
    const queueSnapshot = this.waiters.length;

    const pod = await this.tryAcquireAny(context);
    if (pod) return { pod, queuePosition: 0, waitMs: 0 };

    logger.info({ ...context, queueDepth: this.waiters.length }, "sandbox.queue.wait.started");

    return new Promise<AcquireResult>((resolve, reject) => {
      const position = this.waiters.length + 1;
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

  // How many jobs are queued waiting for a pod
  get queueDepth(): number {
    return this.waiters.length;
  }

  async releasePod(podName: string): Promise<void> {
    await this.clearLease(podName);
    // Pod stays in inMemoryHeld until we either hand it to a waiter or fully free it.
    // This prevents a concurrent tryAcquireAny from stealing the pod mid-handoff.

    const waiter = this.waiters.shift();
    if (!waiter) {
      this.inMemoryHeld.delete(podName);
      logger.info({ pod: podName }, "sandbox.lease.released");
      return;
    }

    const waitMs = Date.now() - waiter.enqueueTime;
    const queuePosition = 1;
    logger.info({ ...waiter.context, waitMs, pod: podName }, "sandbox.queue.wait.completed");

    try {
      await this.acquireLease(podName, waiter.context);
      // inMemoryHeld still contains podName — now held for the new owner
      waiter.resolve(podName, queuePosition, waitMs);
    } catch {
      // Lease conflict from another worker replica — release in-memory hold and find another pod
      this.inMemoryHeld.delete(podName);
      this.waiters.unshift(waiter);
      const result = await this.tryAcquireAny(waiter.context);
      if (result) {
        this.waiters.shift();
        waiter.resolve(result, queuePosition, waitMs);
      }
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
    for (const podName of POD_NAMES) {
      // inMemoryHeld prevents in-process races — Node.js is single-threaded so
      // has+add here is atomic. K8s lease is the authoritative lock for multi-replica safety.
      if (this.inMemoryHeld.has(podName)) continue;
      this.inMemoryHeld.add(podName);

      const acquired = await this.tryAcquireLease(podName, context);
      if (acquired) return podName;
      // K8s rejected it (another worker replica holds it) — free the reservation
      this.inMemoryHeld.delete(podName);
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

  // Annotate the pod with the current tool call id for kubectl observability:
  // kubectl get pods -n sendai -o jsonpath='{.items[*].metadata.annotations}'
  async annotatePod(podName: string, toolCallId: string): Promise<void> {
    try {
      await this.coreApi.patchNamespacedPod({
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
      });
    } catch (err) {
      logger.warn({ pod: podName, err }, "sandbox.annotate.failed (non-fatal)");
    }
  }

  async clearAnnotations(podName: string): Promise<void> {
    try {
      await this.coreApi.patchNamespacedPod({
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
      });
    } catch {
      // non-fatal
    }
  }

  // Watchdog: scan for leases past their TTL and forcibly release them
  private startWatchdog() {
    this.watchdogInterval = setInterval(async () => {
      for (const podName of POD_NAMES) {
        try {
          const lease = await this.coordApi.readNamespacedLease({ name: podName, namespace: this.namespace });
          const spec = lease.spec ?? {};
          if (spec.holderIdentity && this.isExpired(spec)) {
            logger.warn({ pod: podName, holder: spec.holderIdentity }, "sandbox.watchdog.zombie-detected");
            await this.clearLease(podName);
            await this.clearAnnotations(podName);
            this.inMemoryHeld.delete(podName);
            logger.info({ pod: podName }, "sandbox.watchdog.zombie-cleared");
            const waiter = this.waiters.shift();
            if (waiter) {
              const waitMs = Date.now() - waiter.enqueueTime;
              try {
                await this.acquireLease(podName, waiter.context);
                this.inMemoryHeld.add(podName);
                waiter.resolve(podName, 1, waitMs);
              } catch {
                this.waiters.unshift(waiter);
              }
            }
          }
        } catch {
          // ignore per-pod errors
        }
      }
    }, 15_000); // check every 15s
    this.watchdogInterval.unref();
  }

  stopWatchdog() {
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
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
