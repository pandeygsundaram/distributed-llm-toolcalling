import type { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import type { AnthropicClient } from "../anthropic/client.js";

interface ChatBody {
  sessionId: string;
  message: string;
}

export function registerChatRoutes(app: FastifyInstance, client: AnthropicClient) {
  app.post<{ Body: ChatBody }>("/chat", async (req, reply) => {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return reply.status(400).send({ error: "sessionId and message are required" });
    }

    const requestId = uuid();

    const result = await client.runChat({ sessionId, message, requestId });

    return reply.send(result);
  });
}
