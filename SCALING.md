# Scaling the Distributed Pod Execution Architecture

Everything that needs to change as this system grows, in order of priority.

---

## Current State — vScalable Branch (Implemented)

- 2 API server replicas (K8s Deployment, sticky sessions for Pi session affinity)
- 2 Worker replicas (K8s Deployment, same Redis consumer group)
- Sandbox pods autoscaling 4–32 (HPA on queue depth targeting the StatefulSet)
- **Redis as single source of truth for pod locks** (P4 done — K8s Leases removed)
- Dynamic pod discovery via K8s label selector, refreshed every 10s
- Lease heartbeat: PEXPIRE every 10s (TTL=30s, heartbeat fires at TTL/3)
- PostgreSQL for execution history and chat messages (replaces SQLite)
- SSE (`/events`) replacing WebSocket (server-to-client only events, no sticky session requirement)
- Prometheus metrics at `/metrics/prometheus`, JSON dashboard at `/metrics`
- Per-session concurrency limit (Redis INCR/DECR, default 3 inflight per session)
- Dead letter queue (`tool-calls:dlq` Redis stream), inspectable at `GET /dlq`
- Sandbox cleanup between leases (`rm -rf /sandbox/*` before pod release)
- NetworkPolicy blocking all sandbox pod egress except DNS
- Redis Sentinel (3 nodes) with AOF persistence for queue HA

---

## Where Redis Lives

Redis runs **inside the cluster** as a StatefulSet with a persistent volume claim.

```
sendai namespace
├── redis-primary (StatefulSet, 1 replica, 5Gi PVC)
│   └── appendonly: yes, appendfsync: everysec   ← AOF, near-zero data loss
├── redis-replica (Deployment, 1 replica)         ← reads offload + failover target
└── redis-sentinel (Deployment, 3 replicas)       ← majority-vote failover in ~20-30s
```

**Why in-cluster:**
- ~0.5ms round-trip from worker pods vs ~20ms if on EC2
- No external exposure of Redis port
- Same namespace → internal DNS (`redis://redis:6379` just works)

**What happens if Redis goes down:**
- AOF replays all writes on restart — queue and locks recover automatically
- Sentinel detects primary failure in ~5s, votes, promotes replica in ~20-30s
- During that window: new job submissions return 503, inflight jobs keep their 30s lock TTL and finish normally
- Circuit breaker pattern (planned): if Redis unreachable > 5s, reject new jobs gracefully

**If you want fully managed:** AWS ElastiCache Multi-AZ or GCP Memorystore gives you Sentinel-equivalent failover with zero ops overhead. Point `REDIS_URL` at the managed endpoint.

---

## Locking Architecture (P4 — Done)

Redis is now the authoritative lock for pod assignment. K8s Leases are gone.

```
worker.tryAcquirePod(podName):
  SET pod:lock:{podName} {holder} PX 30000 NX
  → "OK"  = lock acquired (30s TTL)
  → null  = already held by another worker

worker.renewLease(podName):         ← heartbeat every 10s
  PEXPIRE pod:lock:{podName} 30000  ← reset TTL while job is running

worker.releasePod(podName):
  DEL pod:lock:{podName}
```

If a worker crashes, the TTL expires in ≤30s and the pod becomes available again — no manual intervention needed.

**Why Redis instead of K8s Leases:**

| | K8s Lease (old) | Redis Lock (new) |
|--|--|--|
| Speed | ~50ms per op (etcd) | ~0.5ms per op |
| Throughput ceiling | ~200 completions/sec | ~50,000/sec |
| Crash recovery | TTL expiry | TTL expiry (same) |
| Observability | `kubectl describe lease` | `GET /pods` dashboard, Redis CLI |
| Multi-worker safe | Yes (etcd consensus) | Yes (Redis single-writer) |
| Needs Sentinel | No (etcd is already HA) | Yes (for Redis HA) |

---

## Layer 1 — Correctness (Done in vScalable)

### 1.1 Lease Renewal Heartbeat ✅

Worker calls `leaseManager.renewLease(podName)` every 10s (`PEXPIRE pod:lock:{name} 30000`).
Long-running tools no longer lose their pod mid-execution.

### 1.2 Redis as Authoritative Lock ✅

`SET pod:lock:{name} {holder} PX 30000 NX` — replaces both `inMemoryHeld` Set (single-process) and K8s Lease (slow). All workers share the same Redis → zero race conditions.

### 1.3 Replace SQLite with PostgreSQL ✅

`better-sqlite3` removed. Both `ExecutionStore` and `ChatStore` now use a shared `pg.Pool`.
Schema unchanged — same tables, parameterized queries (`$1, $2`).
`initDb()` called at server startup creates tables if they don't exist.

---

## Layer 2 — Horizontal Scaling (Done in vScalable)

### 2.1 Multi-Worker Deployment ✅

`k8s/worker-deployment.yaml`: `replicas: 2`

Each worker has a unique `CONSUMER_NAME` (`worker-{hostname}-{uuid}`). Redis Streams consumer groups distribute jobs so each message goes to exactly one worker. Scaling from 1 to N workers: `kubectl scale deployment sendai-worker --replicas=N`.

### 2.2 API Server Replicas + Sticky Sessions ✅

`k8s/api-deployment.yaml`: `replicas: 2`, `sessionAffinity: ClientIP` (1hr timeout)

Sticky sessions ensure the in-memory Pi session Map (`PiClient.sessions`) stays consistent — a request for session X always hits the same API replica that created it. If a replica restarts, that session starts fresh (acceptable trade-off vs full session serialization to DB).

### 2.3 Dynamic Pod Discovery ✅

LeaseManager queries K8s label selector `app=sandbox-runner, status.phase=Running` every **10s** (down from original 30s). New pods added by HPA are visible within 10s. Retains last known list on failure.

---

## Layer 3 — Pod Pool Autoscaling (K8s Manifests Done)

### 3.1 HPA Targets the Sandbox StatefulSet ✅

`k8s/hpa.yaml` scales `sandbox-runner` StatefulSet (the pod pool), not the worker Deployment.

**Why the StatefulSet, not the worker:**
Scaling workers just adds more consumers. The bottleneck is pods — more pods = more parallel tool executions. One worker can easily feed 20+ pods; a single Node.js process pulling from Redis at 0.5ms can saturate a much larger pool than we'll ever have.

```yaml
scaleTargetRef:
  kind: StatefulSet
  name: sandbox-runner    # ← the pod pool, not the worker
minReplicas: 4
maxReplicas: 32
metrics:
  - type: External          # queue depth via prometheus-adapter
    external:
      metric: redis_stream_length
      target:
        type: AverageValue
        averageValue: "2"   # scale when avg 2+ jobs wait per pod
  - type: Resource          # CPU fallback (no prometheus-adapter needed)
    resource:
      name: cpu
      target: { type: Utilization, averageUtilization: 70 }
```

Scale-up: fast (+4 pods per 60s, 30s stabilization)
Scale-down: slow (−2 pods per 120s, 300s stabilization) — avoids thrash

---

## Layer 4 — Queue HA

### 4.1 Redis Sentinel ✅

`k8s/redis-sentinel/`:
- `redis-primary.yaml` — StatefulSet, AOF enabled, 5Gi PVC
- `redis-replica.yaml` — Deployment, replicates from primary
- `sentinel.yaml` — 3 sentinel replicas, `quorum=2`, 5s detection, 30s failover

Wire sentinel support: set `REDIS_SENTINEL_URLS=sentinel-0:26379,sentinel-1:26379,sentinel-2:26379` in worker/api env, and the ioredis client switches to Sentinel mode automatically.

### 4.2 Dead Letter Queue ✅

`DLQ_KEY = "tool-calls:dlq"` — failed jobs are XADD'd here with error + pod + timestamp.
Inspect via `GET /dlq` → returns last 100 DLQ entries.
Original job always ACKed (prevents infinite redelivery). DLQ is an audit trail, not a retry queue.

---

## Layer 5 — Per-Session Fair Use

### 5.1 Per-Session Concurrency Limit ✅

In `routes/chat.ts`, before dispatching a tool call:
```
INCR session:inflight:{sessionId}  →  n
```
If `n > MAX_SESSION_INFLIGHT` (default 3): return 429.
DECR in `finally` block (always runs, even on error).
5-min safety TTL prevents counter leaks from crashes.

---

## Layer 6 — Observability

### 6.1 Prometheus Metrics ✅

`src/metrics/index.ts` uses `prom-client`. Counters, histograms, and gauges registered in a custom `Registry`.

Key metrics:
- `tool_calls_total{tool, status}` — Counter
- `tool_call_duration_ms{tool}` — Histogram (buckets: 10ms → 30s)
- `queue_depth` — Gauge
- `pods_in_use` — Gauge
- `queue_wait_ms` — Histogram
- `dlq_total{tool}` — Counter

**Endpoints:**
- `GET /metrics/prometheus` — Prometheus scraping (text/plain)
- `GET /metrics` — JSON snapshot for the dashboard

**To hook up HPA:** install `prometheus-adapter` in the cluster. It reads from Prometheus and exposes `custom.metrics.k8s.io/redis_stream_length` for the HPA to consume.

---

## Layer 7 — Real-Time Transport

### 7.1 WebSocket → SSE ✅

All events are server→client only. WebSocket was the wrong tool.

```
Old: ws://host/ws   →   WebSocket (bidirectional, needs sticky sessions, fails through proxies)
New: GET /events    →   SSE (server→client, works through every proxy, native EventSource reconnect)
```

Frontend `useWebSocket.ts` now uses `EventSource` instead of `WebSocket` — same interface, drop-in replacement.

No more `ws` npm package. No more upgrade handler. No sticky session requirement for the event stream.

---

## Layer 8 — Security

### 8.1 NetworkPolicy ✅

`k8s/networkpolicy.yaml` — blocks all sandbox pod egress except DNS (port 53).
Sandbox code cannot reach the internet, internal services, or other pods.
`kubectl exec` from the control plane still works (ingress from K8s API server).

### 8.2 Sandbox Cleanup Between Leases ✅

`PodExecutor.cleanup(podName)` runs `rm -rf /sandbox/* /sandbox/.[!.]*` before each pod release.
Session A's files don't leak to session B on the same pod.
Cleanup failure is logged but non-fatal — pod is released anyway.

---

## Layer 9 — Where API + Worker Run

### 9.1 Everything in the Cluster ✅

```
k8s/api-deployment.yaml   →   2 replicas, in-cluster
k8s/worker-deployment.yaml →   2 replicas, in-cluster
```

In-cluster latency: ~1ms for every operation (Redis, K8s API, exec into sandbox pod).
EC2-hosted equivalent: ~20-50ms per operation, every single tool call, forever.

---

## Priority Status

| Priority | Change | Status |
|----------|--------|--------|
| 🔴 P0 | Lease renewal heartbeat | ✅ Done (Redis PEXPIRE every 10s) |
| 🔴 P0 | Redis SETNX fast reservation | ✅ Done (SET NX PX is authoritative lock) |
| 🔴 P0 | Replace SQLite with Postgres | ✅ Done |
| 🟠 P1 | Multi-worker deployment | ✅ Done (replicas: 2) |
| 🟠 P1 | Pi session state (sticky sessions) | ✅ Done (sessionAffinity: ClientIP) |
| 🟠 P1 | Dynamic pod discovery via label selector | ✅ Done (10s interval) |
| 🟠 P1 | Move API server + worker into cluster | ✅ Done (K8s Deployments) |
| 🟡 P2 | HPA on queue depth (targets StatefulSet) | ✅ Done (k8s/hpa.yaml) |
| 🟡 P2 | Prometheus metrics + alerting | ✅ Done (prom-client, /metrics/prometheus) |
| 🟡 P2 | Per-session concurrency limit | ✅ Done (Redis INCR, max 3 inflight) |
| 🟡 P2 | Replace WebSocket with SSE | ✅ Done (/events endpoint, EventSource) |
| 🟢 P3 | Redis Sentinel for queue HA | ✅ Done (k8s/redis-sentinel/) |
| 🟢 P3 | Dead letter queue | ✅ Done (tool-calls:dlq, GET /dlq) |
| 🟢 P3 | NetworkPolicy for pod isolation | ✅ Done (k8s/networkpolicy.yaml) |
| 🟢 P3 | Sandbox cleanup between leases | ✅ Done (rm -rf before release) |
| ⚪ P4 | Replace K8s Lease with Redis Lock | ✅ Done (was P4, implemented directly) |
| ⚪ P4 | Custom K8s controller/operator | — Skip (only needed at 1000+ pods) |
| ⚪ P4 | OpenTelemetry distributed tracing | — Skip (nice-to-have) |
