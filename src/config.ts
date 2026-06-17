import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  SANDBOX_DIR: z.string().default("./sandbox"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  USE_REDIS: z.string().optional(),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),
  REDIS_SENTINEL_URLS: z.string().optional(), // comma-separated sentinel host:port pairs

  // Postgres (replaces SQLite)
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/sendai"),

  // Kubernetes
  K8S_NAMESPACE: z.string().default("sendai"),
  QUEUE_MAX_WAIT_MS: z.coerce.number().default(15_000),
  TOOL_TIMEOUT_MS: z.coerce.number().default(30_000),
  LEASE_TTL_SECONDS: z.coerce.number().default(30),      // Redis lock TTL (30s — lower than old K8s Lease 45s)
  POD_DISCOVERY_INTERVAL_MS: z.coerce.number().default(10_000),  // re-discover pods every 10s

  // Per-session concurrency
  MAX_SESSION_INFLIGHT: z.coerce.number().default(3),
});

const result = schema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Missing or invalid environment variables:");
  for (const issue of result.error.issues) {
    console.error(`   ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = result.data;
