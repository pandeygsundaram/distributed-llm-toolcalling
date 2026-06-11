import Fastify from "fastify";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { LocalExecutor } from "./executor/local.js";
import { RedisExecutor } from "./executor/redis.js";
import { AnthropicClient } from "./anthropic/client.js";
import { LeaseManager } from "./sandbox/lease-manager.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPodsRoutes } from "./routes/pods.js";

async function main() {
  const useRedis = process.env.USE_REDIS === "true";

  let executor: LocalExecutor | RedisExecutor;
  let leaseManager: LeaseManager | null = null;

  if (useRedis) {
    logger.info("executor: redis (phase 2)");
    executor = new RedisExecutor();
    leaseManager = new LeaseManager();
  } else {
    logger.info("executor: local (phase 1)");
    executor = new LocalExecutor();
    await (executor as LocalExecutor).init();
  }

  const anthropicClient = new AnthropicClient(executor);

  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, "unhandled request error");
    reply.status(500).send({ error: "internal server error" });
  });

  registerHealthRoutes(app, leaseManager);
  registerPodsRoutes(app, leaseManager);
  registerChatRoutes(app, anthropicClient);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info({ port: config.PORT, mode: useRedis ? "redis" : "local" }, "server started");
}

main().catch((err) => {
  logger.error({ err }, "fatal: server failed to start");
  process.exit(1);
});
