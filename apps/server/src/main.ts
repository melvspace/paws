import { isAllowedRequestOrigin } from "./requestOrigin.ts";
import * as Http from "node:http";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Schema } from "effect";
import { WebSocketServer } from "ws";
import { CreateAgent, UpdateAgent } from "@paws/contracts";
import { makeAgentService } from "./AgentService.ts";
import { makeProviderService } from "./ProviderService.ts";
import { providerHttp } from "./providerHttp.ts";
import { makeChatService } from "./ChatService.ts";
import { makeChatRunner } from "./chatRunner.ts";
import { chatHttp } from "./chatHttp.ts";
import type { RunChatTurn } from "@paws/provider-core";

export function createServer(
  root: string,
  options: {
    runChat?: RunChatTurn;
    discoverProviders?: Parameters<typeof makeProviderService>[1];
  } = {},
) {
  const agents = makeAgentService(root);
  const providers = makeProviderService(root, options.discoverProviders, () => {
    void broadcast().catch(() => {});
  });
  const chat = makeChatService(
    root,
    providers.list,
    options.runChat ?? makeChatRunner(root, providers),
    () => {
      void broadcast().catch(() => {});
    },
  );
  const snapshot = () =>
    Effect.runPromise(agents.list()).then((items) => ({
      agents: items,
      providers: providers.list(),
      conversations: chat.list(),
    }));
  const server = Http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");

    if (!isAllowedRequestOrigin(request.headers)) {
      response
        .writeHead(403)
        .end(JSON.stringify({ error: "Origin not allowed" }));

      return;
    }

    try {
      if (await providerHttp(request, response, providers)) return;
      if (await chatHttp(request, response, chat)) return;

      if (request.method === "GET" && request.url === "/api/agents") {
        response.end(JSON.stringify(await snapshot()));

        return;
      }

      const agentId = /^\/api\/agents\/([^/]+)$/.exec(request.url ?? "")?.[1];

      if (request.method === "DELETE" && agentId) {
        const exists = (await Effect.runPromise(agents.list())).some(
          (agent) => agent.id === agentId,
        );

        if (exists) await chat.remove(agentId);

        const removed = await Effect.runPromise(agents.remove(agentId));

        if (!removed) {
          response
            .writeHead(404)
            .end(JSON.stringify({ error: "Agent not found" }));

          return;
        }

        await broadcast();
        response.writeHead(204).end();

        return;
      }

      const updateId = request.method === "PATCH" ? agentId : undefined;
      const isCreate =
        request.method === "POST" && request.url === "/api/agents";

      if (isCreate || updateId) {
        if (request.headers["content-type"] !== "application/json") {
          response
            .writeHead(415)
            .end(JSON.stringify({ error: "Expected application/json" }));

          return;
        }

        let body = "";

        for await (const chunk of request) {
          body += chunk;

          if (Buffer.byteLength(body) > 65536) {
            response
              .writeHead(413)
              .end(JSON.stringify({ error: "Request too large" }));

            return;
          }
        }

        const input = Schema.decodeUnknownSync(
          isCreate ? CreateAgent : UpdateAgent,
        )(JSON.parse(body));
        const agent = await Effect.runPromise(
          updateId ? agents.update(updateId, input) : agents.create(input),
        );

        if (!agent) {
          response
            .writeHead(404)
            .end(JSON.stringify({ error: "Agent not found" }));

          return;
        }

        await broadcast();

        response.writeHead(isCreate ? 201 : 200).end(JSON.stringify(agent));

        return;
      }

      response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
    } catch {
      response.writeHead(400).end(
        JSON.stringify({
          error: "Unable to process request. Check the agent fields.",
        }),
      );
    }
  });
  const sockets = new WebSocketServer({ server, path: "/ws" });

  async function broadcast() {
    const state = JSON.stringify(await snapshot());

    for (const client of sockets.clients) {
      if (client.readyState === 1) {
        client.send(state);
      }
    }
  }

  sockets.on("connection", (socket, request) => {
    if (!isAllowedRequestOrigin(request.headers)) {
      socket.close(1008, "Origin not allowed");

      return;
    }

    void snapshot()
      .then((state) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(state));
        }
      })
      .catch(() => socket.close(1011, "Unable to load agents"));
  });

  return {
    server,
    providers,
    chat,
    close: async () => {
      for (const client of sockets.clients) {
        client.terminate();
      }

      sockets.close();
      server.close();
      await chat.close();
      await providers.close();
      agents.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root =
    process.env.PAWS_HOME ??
    Path.resolve(import.meta.dirname, "../../../.paws");
  const app = createServer(root);
  app.server.listen(4310, "127.0.0.1", () =>
    console.log("Paws server: http://127.0.0.1:4310"),
  );
  for (const provider of app.providers.list()) {
    if (
      provider.config.enabled &&
      !["acpRegistry", "antigravity"].includes(provider.config.driver)
    ) {
      void app.providers.refresh(provider.config.id);
    }
  }
  process.once("SIGINT", app.close);
  process.once("SIGTERM", app.close);
}
