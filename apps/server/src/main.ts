import {
  nativeMcpAuthHttp,
  closeNativeMcpLogins,
} from "./teamMcpNativeAuth.ts";
import { teamMcpHarness } from "./teamMcpHarness.ts";
import { teamMcpAuthHttp } from "./teamMcpAuth.ts";
import { saveIntegrationSecrets } from "./teamIntegrations.ts";
import { closeTeamCommands } from "./teamCommandSessions.ts";
import { teamResources } from "./teamResources.ts";
import { isAllowedRequestOrigin } from "./requestOrigin.ts";
import * as Http from "node:http";
import { homedir } from "node:os";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Schema } from "effect";
import { WebSocketServer } from "ws";
import {
  CreateAgent,
  UpdateAgent,
  SaveTeam,
  MoveAgentTeam,
} from "@paws/contracts";
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
    Effect.runPromise(agents.list()).then(async (items) => ({
      agents: items,
      providers: providers.list(),
      teams: await Effect.runPromise(agents.listTeams()),
      conversations: chat.list(),
    }));
  const server = Http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");

    const findIntegration = async (teamId: string, integrationId: string) =>
      (await Effect.runPromise(agents.listTeams()))
        .find((team) => team.id === teamId)
        ?.integrations?.find((integration) => integration.id === integrationId);
    const findHarness = (providerId: string) => {
      const provider = providers
        .list()
        .find((item) => item.config.id === providerId && item.config.enabled);

      return provider ? teamMcpHarness(root, provider.config) : undefined;
    };

    if (
      await nativeMcpAuthHttp(
        request,
        response,
        root,
        findIntegration,
        findHarness,
      ).catch(() => {
        response.writeHead(400).end("Harness sign-in failed. Retry from Paws.");

        return true;
      })
    )
      return;

    if (
      await teamMcpAuthHttp(request, response, root, findIntegration).catch(
        () => {
          response.writeHead(400).end("MCP sign-in failed. Retry from Paws.");

          return true;
        },
      )
    )
      return;

    if (!isAllowedRequestOrigin(request.headers)) {
      response
        .writeHead(403)
        .end(JSON.stringify({ error: "Origin not allowed" }));

      return;
    }

    try {
      const credentials =
        /^\/api\/teams\/([^/]+)\/integrations\/([^/]+)\/credentials$/.exec(
          request.url ?? "",
        );

      if (credentials && request.method === "POST") {
        const team = (await Effect.runPromise(agents.listTeams())).find(
          (team) => team.id === credentials[1],
        );

        if (!team?.integrations?.some((item) => item.id === credentials[2])) {
          response
            .writeHead(404)
            .end(JSON.stringify({ error: "Integration not found." }));

          return;
        }

        if (request.headers["content-type"] !== "application/json") {
          response.writeHead(415).end();

          return;
        }

        let body = "";

        for await (const chunk of request) {
          body += chunk;

          if (Buffer.byteLength(body) > 65536) {
            response.writeHead(413).end();

            return;
          }
        }

        const input = Schema.decodeUnknownSync(
          Schema.Struct({ name: Schema.String, value: Schema.String }),
        )(JSON.parse(body));
        saveIntegrationSecrets(root, team.id, credentials[2]!, {
          [input.name]: input.value,
        });
        response.writeHead(204).end();

        return;
      }

      if (
        await teamResources(request, response, root, async (id) =>
          (await Effect.runPromise(agents.listTeams())).some(
            (team) => team.id === id,
          ),
        )
      )
        return;
      if (await providerHttp(request, response, providers)) return;
      if (await chatHttp(request, response, chat)) return;

      if (request.method === "GET" && request.url === "/api/agents") {
        response.end(JSON.stringify(await snapshot()));

        return;
      }

      const teamId = /^\/api\/teams\/([^/]+)$/.exec(request.url ?? "")?.[1];

      if (request.method === "DELETE" && teamId) {
        for (const agent of await Effect.runPromise(agents.list())) {
          if (agent.teamIds?.includes(teamId)) await chat.stop(agent.id);
        }

        await closeNativeMcpLogins(root, teamId);
        await closeTeamCommands(root, teamId);
        const removed = await Effect.runPromise(agents.removeTeam(teamId));
        await broadcast();
        response.writeHead(removed ? 204 : 404).end();

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

      const moveId =
        request.method === "POST"
          ? /^\/api\/agents\/([^/]+)\/move$/.exec(request.url ?? "")?.[1]
          : undefined;
      const isTeamCreate =
        request.method === "POST" && request.url === "/api/teams";
      const isTeamUpdate = request.method === "PATCH" && teamId;

      if (isCreate || updateId || isTeamCreate || isTeamUpdate || moveId) {
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

        if (moveId) {
          const input = Schema.decodeUnknownSync(MoveAgentTeam)(
            JSON.parse(body),
          );

          if (chat.get(moveId).status !== "idle") {
            response.writeHead(409).end(
              JSON.stringify({
                error: "Only idle agents can move between teams.",
              }),
            );

            return;
          }

          const moved = Effect.runSync(agents.moveTeam(moveId, input));
          await broadcast();
          response.end(JSON.stringify(moved));

          return;
        }

        if (isTeamCreate || isTeamUpdate) {
          const input = Schema.decodeUnknownSync(SaveTeam)(JSON.parse(body));
          const team = await Effect.runPromise(agents.saveTeam(input, teamId));

          if (team && input.integrations) {
            await closeNativeMcpLogins(
              root,
              team.id,
              input.integrations.map((item) => item.id),
            );
            await closeTeamCommands(
              root,
              team.id,
              input.integrations.map((item) => item.id),
            );
          }

          await broadcast();
          response
            .writeHead(team ? (isTeamCreate ? 201 : 200) : 404)
            .end(JSON.stringify(team));

          return;
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

        if (updateId && input.teamIds) await chat.stop(updateId);

        await broadcast();

        response.writeHead(isCreate ? 201 : 200).end(JSON.stringify(agent));

        return;
      }

      response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
    } catch {
      response.writeHead(400).end(
        JSON.stringify({
          error: "Unable to process request. Check the submitted fields.",
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
      await closeNativeMcpLogins(root);
      await closeTeamCommands(root);
      await providers.close();
      agents.close();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = process.env.PAWS_HOME ?? Path.join(homedir(), ".paws");
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
