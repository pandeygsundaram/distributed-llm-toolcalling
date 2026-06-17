# Sendai — Distributed LLM Tool Execution on Kubernetes

A production-grade TypeScript backend that runs an LLM agent where every tool call executes inside an isolated Kubernetes pod. Claude decides which tool to call, the request flows through Redis Streams to a worker that acquires a Redis lock on a sandbox pod, executes the command via `pods/exec`, and streams the result back in real time over SSE.

---

## Architecture

```mermaid
flowchart TD
    Client(["Client\nbrowser / curl"])

    subgraph K8s["Kubernetes — sendai namespace"]
        subgraph API["sendai-api  ×2 replicas"]
            Express["Express 5\nPi Agent + Claude"]
            SSE["SSE broadcaster\nGET /events"]
            Metrics["Prometheus\n/metrics/prometheus"]
        end

        subgraph Workers["sendai-worker  ×2 replicas"]
            Consumer["Redis consumer group\nXREADGROUP"]
            LM["LeaseManager\nRedis SET NX PX\nheartbeat PEXPIRE/10s"]
            DLQ["DLQ writer\ntool-calls:dlq"]
        end

        subgraph Pods["sandbox-runner StatefulSet  (HPA 4→32)"]
            P0["sandbox-runner-0"]
            P1["sandbox-runner-1"]
            Pdot["…"]
            P7["sandbox-runner-7"]
        end
    end

    Redis[("Redis\nexternal URL\nStreams · Pub/Sub\npod locks · DLQ · counters")]
    Postgres[("PostgreSQL\nexternal URL\nexecutions · chat_messages")]

    Client -->|"POST /chat\n(per-session 429 if > 3 inflight)"| Express
    Client <-->|"GET /events  SSE"| SSE

    Express <-->|"tool_use / tool_result"| Claude(["Claude\nAnthropic API"])
    Express -->|"XADD tool-calls"| Redis
    Express -->|"SUBSCRIBE result:id"| Redis
    Express -->|"write executions\nchat_messages"| Postgres

    Redis -->|"XREADGROUP"| Consumer
    Consumer --> LM
    LM -->|"SET pod:lock NX PX 30000"| Redis
    LM -->|"pods/exec"| P0
    LM -->|"pods/exec"| P1
    LM -->|"pods/exec"| Pdot
    LM -->|"pods/exec"| P7
    LM -->|"PUBLISH result:id"| Redis
    Consumer -->|"on failure"| DLQ
    DLQ -->|"XADD tool-calls:dlq"| Redis

    SSE -->|"pods_update\ntool_result\npermission_request"| Client
```

---

## Request flow

1. `POST /chat` arrives with `sessionId` + `message`
2. Per-session concurrency check: `INCR session:inflight:{id}` — reject 429 if > 3
3. API calls Claude with tool definitions; Claude replies with a `tool_use` block
4. API publishes job to the `tool-calls` Redis stream (`XADD`)
5. Worker reads via `XREADGROUP`, acquires pod lock: `SET pod:lock:{name} {holder} PX 30000 NX`
6. If all 8 pods busy → FIFO queue (15s timeout, returns `sandbox_capacity_timeout`)
7. Worker starts heartbeat: `PEXPIRE pod:lock:{name} 30000` every 10s — long jobs can't lose their pod
8. Tool runs inside the pod via `kubectl exec`
9. On failure → `XADD tool-calls:dlq` for inspection at `GET /dlq`
10. Worker publishes result, runs `rm -rf /sandbox/*`, releases lock
11. API returns result to Claude → Claude produces final message → response to client

---

## Locking model

Redis is the authoritative lock — no K8s Leases, no etcd writes.

```
Acquire:  SET pod:lock:{name} {instanceId}:{toolCallId} PX 30000 NX
            → "OK"  = got it       → null = try next pod
Renew:    PEXPIRE pod:lock:{name} 30000   (heartbeat every 10s)
Release:  DEL pod:lock:{name}
```

If a worker crashes mid-job, the 30s TTL expires and the pod becomes available automatically.

| | K8s Lease (old) | Redis Lock (current) |
|--|--|--|
| Latency | ~50ms (etcd) | ~0.5ms |
| Throughput ceiling | ~200/sec | ~50,000/sec |
| Crash recovery | TTL expiry | TTL expiry |
| Observability | kubectl | `GET /pods`, Redis CLI |

---

## Tools

| Tool | What it does | Approval required |
|------|-------------|-------------------|
| `shell_run` | Allowlisted shell commands (`pwd`, `ls`, `whoami`, `node --version`, `sleep`, …) | No |
| `fs_read` | Read a file from `/sandbox` (path-traversal blocked) | No |
| `fs_write` | Write a file to `/sandbox` | **Yes — human-in-the-loop** |
| `env_inspect` | Pod name, namespace, hostname, Node version | No |
| `math_compute` | Arithmetic, factorial, fibonacci | No |

`fs_write` pauses the agent loop, broadcasts a `permission_request` event over SSE, and waits for `POST /approve/{id}` before continuing.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22, TypeScript |
| API framework | Express 5 |
| LLM | Anthropic Claude (`claude-sonnet-4-6`) via Pi coding agent |
| Queue / locks | Redis Streams + Pub/Sub (`ioredis`) |
| Persistence | PostgreSQL (`pg`) — execution history + chat messages |
| Orchestration | Kubernetes (`@kubernetes/client-node`) — StatefulSet, `pods/exec` |
| Metrics | `prom-client` — Prometheus at `/metrics/prometheus` |
| Real-time | SSE (`GET /events`) — replaces WebSocket |
| Autoscaling | HPA on `sandbox-runner` StatefulSet (4→32 pods) |
| Local cluster | kind (`workflow-cluster`) |

---

## Getting started

### Prerequisites

- Node.js 22+
- Docker
- kind (`kind create cluster --name workflow-cluster`)
- kubectl configured to the kind cluster
- Redis running locally (`redis-server` or `docker run -p 6379:6379 redis:7-alpine`)
- PostgreSQL running locally (`docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sendai postgres:16-alpine`)

### 1. Install and configure

```bash
npm install
cp .env.example .env
# Set ANTHROPIC_API_KEY in .env
```

### 2. Apply base K8s manifests

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/statefulset.yaml    # sandbox-runner-0..7

kubectl wait --for=condition=ready pod -l app=sandbox-runner -n sendai --timeout=120s
```

### 3. Build and load the container image

```bash
npm run build
docker build -t sendai:latest .
kind load docker-image sendai:latest --name workflow-cluster
```

### 4. Create secrets

The app reads Postgres and Redis as plain URLs — point them at wherever you're running those services. Inside kind pods, the host machine is reachable at `172.20.0.1` (the Docker bridge gateway).

```bash
kubectl create secret generic sendai-secrets \
  --namespace sendai \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-..." \
  --from-literal=DATABASE_URL="postgres://postgres:postgres@172.20.0.1:5432/sendai" \
  --from-literal=REDIS_URL="redis://172.20.0.1:6379"
```

### 5. Deploy API and worker

```bash
kubectl apply -f k8s/api-deployment.yaml
kubectl apply -f k8s/worker-deployment.yaml

kubectl rollout status deployment/sendai-api deployment/sendai-worker -n sendai
```

### 6. Access the API

```bash
kubectl port-forward svc/sendai-api 3000:3000 -n sendai &

curl -s localhost:3000/health | jq .
# → {"ok":true,"phase":"2-redis","kubernetes":"connected","sandboxPodsReady":8}

curl -s -X POST localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"s1","message":"run whoami and show me the pod name"}' | jq .
```

### Running locally (dev mode)

```bash
npm run dev         # API server on :3000
npm run dev:worker  # worker process
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Run a chat turn with tool execution |
| `GET` | `/events` | SSE stream — pod updates, tool results, approval requests |
| `GET` | `/pods` | Redis lock state of all sandbox pods |
| `GET` | `/health` | Liveness — K8s connectivity + pod count |
| `GET` | `/executions` | Execution history from Postgres |
| `GET` | `/dlq` | Last 100 dead-letter queue entries |
| `GET` | `/metrics` | JSON dashboard snapshot |
| `GET` | `/metrics/prometheus` | Prometheus text format |
| `POST` | `/approve/{id}` | Approve or reject a pending `fs_write` |

---

## Running tests

```bash
npm test                  # 30 unit tests (no cluster needed)
npm run test:integration  # 22 integration tests (server + worker running)
npm run test:approval     # 5 HITL approval tests
npm run stress            # Phase stress test (5 phases, 8-pod pool)
npm run stress:limits     # Architecture limits — all 10 features under load
```

### Architecture limits results (8 pods)

| Test | Result |
|------|--------|
| 200 concurrent vs 8 pods | 190/200 completed, 0 crashes, queue absorbed burst |
| Sustained throughput | 61 tps at p50=60ms, p95=80ms — 120/120 across 15 batches |
| Per-session 429 | Fires exactly on the 4th concurrent request from same session |
| DLQ poison pill | Unknown tool captured with full error message |
| Sandbox isolation | File written in lease N absent in lease N+1 |
| SSE fan-out | 20/20 clients receive same broadcast |
| Dynamic pod discovery | New pods (sandbox-runner-8, -9) in rotation within 12s of scale-up |
| Postgres concurrent writes | 0 5xx errors under 20 concurrent chat requests |
| Redis lock race | 8 unique pods, zero double-assignment across 8 concurrent jobs |
| Heartbeat / lock theft | 0 pod thefts in 3 attempts spanning full 30s TTL |

---

## Redis — what survives if things go wrong

Redis holds the job queue, pod locks, and session counters. Here's exactly what each failure means:

### Pod restart (normal)
Redis is a Deployment — pod restarts lose in-memory data. In-flight jobs at the moment of restart fail; their 30s lock TTL expires and pods become free. Queue drains on the next worker startup. **Mitigation already in place**: the worker ACKs jobs only after completion, so unprocessed messages stay in the Redis stream's pending list and are redelivered on reconnect.

### Full cluster restart (kind/minikube stop + start)
All pod memory is lost — Redis, queue, locks, counters all gone. Execution history and chat messages survive because they're in **PostgreSQL on the host**, outside the cluster. New jobs start clean.

### What never gets lost
- **Execution history** — written to Postgres on the host
- **Chat messages** — written to Postgres on the host
- **Approved/rejected decisions** — written to Postgres

### If you need Redis to survive cluster restarts (production path)

**Option A — Managed Redis (recommended for production)**
Use AWS ElastiCache, GCP Memorystore, or Upstash. Point `REDIS_URL` at the managed endpoint. No ops, automatic failover, data lives outside the cluster entirely.

**Option B — In-cluster Redis with AOF persistence**
The `k8s/redis-sentinel/redis-primary.yaml` manifest in this repo deploys Redis as a StatefulSet with a 5Gi PVC and `appendonly yes, appendfsync everysec`. AOF replays all writes on restart — the queue and any unprocessed stream messages come back. Sentinel (`k8s/redis-sentinel/sentinel.yaml`) gives ~30s automatic failover if the primary pod crashes.

```bash
# To switch to in-cluster persistent Redis:
kubectl apply -f k8s/redis-sentinel/
# Then update the secret:
kubectl create secret generic sendai-secrets --namespace sendai \
  --from-literal=REDIS_URL="redis://redis:6379" \
  ... --dry-run=client -o yaml | kubectl apply -f -
```

**Option C — Periodic RDB snapshot to S3**
Add a sidecar or CronJob that runs `redis-cli BGSAVE` and uploads `/data/dump.rdb` to S3. Restore point is the last snapshot (up to 15min of data loss). Combine with AOF for near-zero loss.

### The bottom line
The job queue is **ephemeral by design** — a tool call is a short-lived RPC, not durable state. If Redis goes down mid-flight, the LLM call fails, the user retries, and the system recovers. The durable record of what happened lives in Postgres. Redis is the fast lane, Postgres is the ledger.

---

## Autoscaling

The HPA in `k8s/hpa.yaml` targets the `sandbox-runner` **StatefulSet** (the pod pool), not the worker Deployment. Scaling workers adds more queue consumers — the real bottleneck is pods.

```
minReplicas: 4    maxReplicas: 32
Scale trigger: redis_stream_length averageValue > 2 jobs waiting per pod
CPU fallback:  70% utilization
Scale-up:  +4 pods / 60s  (30s stabilization window — fast)
Scale-down: -2 pods / 120s (300s stabilization window — slow, avoids thrash)
```

At 32 pods with ~60ms/call → ~530 tool calls/sec theoretical ceiling.

---

## Project structure

```
src/
  routes/         chat, pods, health, executions, metrics
  sandbox/        lease-manager.ts (Redis locks + pod discovery)
                  pod-executor.ts  (kubectl exec + cleanup)
  queue/          redis-client.ts  (stream, pub/sub, lock helpers)
  worker/         index.ts — Redis consumer + heartbeat + DLQ
  history/        store.ts + chat-store.ts (Postgres via pg.Pool)
                  db.ts — shared pool + initDb()
  metrics/        index.ts (prom-client counters/histograms)
  ws/             broadcaster.ts (SSE fan-out)
  tools/          shell_run, fs_read, fs_write, env_inspect, math_compute
  executor/       redis.ts — RedisExecutor (publish + wait for result)
k8s/
  namespace.yaml          sendai namespace
  rbac.yaml               ServiceAccount + Role (pods/exec, list, watch)
  statefulset.yaml        sandbox-runner StatefulSet + headless Service
  api-deployment.yaml     sendai-api Deployment (×2) + NodePort Service
  worker-deployment.yaml  sendai-worker Deployment (×2)
  hpa.yaml                HPA targeting sandbox-runner StatefulSet
  networkpolicy.yaml      Block sandbox pod egress except DNS
  redis-sentinel/         In-cluster HA Redis (optional, production path)
tests/
  unit/           30 tests — tool logic, store, no cluster needed
  integration/    22 tests — live API + worker
  integration/approval.test.ts  5 HITL tests
  stress/stress.ts        Phase load test
  stress/limits.ts        Architecture limits (10 scenarios)
```
