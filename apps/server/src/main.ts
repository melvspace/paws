import { makeBrowserService } from "./BrowserService.ts";
import { webAssets } from "./webAssets.ts";
import { startCompanion } from "./companion.ts";
import { browserSockets } from "./browserSockets.ts";
import { makeTeamworkService } from "./TeamworkService.ts";
import { peerMessageHttp } from "./peerMessageHttp.ts";
import { makeAgentManagementService } from "./AgentManagementService.ts";
import { chatHistoryPage } from "./chatHistoryPaging.ts";
import { makeMemoryService } from "./MemoryService.ts";
import { memoryHttp } from "./memoryHttp.ts";
import {
  makeRoutineService,
  configuredRoutineLimits,
  routineLimits,
} from "./RoutineService.ts";
import { routineHttp } from "./routineHttp.ts";
import { serializeAgentExecution } from "./agentExecution.ts";
import { isDeepStrictEqual } from "node:util";
import {
  nativeMcpAuthHttp,
  closeNativeMcpLogins,
} from "./teamMcpNativeAuth.ts";
import { teamMcpHarness } from "./teamMcpHarness.ts";
import { teamMcpAuthHttp } from "./teamMcpAuth.ts";
import { saveIntegrationSecrets } from "./teamIntegrations.ts";
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
  TeamIntegration,
  UpdateTeam,
  MoveAgentTeam,
} from "@paws/contracts";
import { makeAgentService } from "./AgentService.ts";
import { makeProviderService } from "./ProviderService.ts";
import { providerHttp } from "./providerHttp.ts";
import { ChatError, makeChatService } from "./ChatService.ts";
import { makeChatRunner } from "./chatRunner.ts";
import { chatHttp } from "./chatHttp.ts";
import { ChatExecutionError, type RunChatTurn } from "@paws/provider-core";

export function createServer(
  root: string,
  options: {
    runChat?: RunChatTurn;
    routineLimits?: typeof routineLimits;
    discoverProviders?: Parameters<typeof makeProviderService>[1];
    launchBrowser?: Parameters<typeof makeBrowserService>[1];
    webRoot?: string;
  } = {},
) {
  let teamworkRevision = 0;
  const browsers = makeBrowserService(
    root,
    options.launchBrowser,
    (id) =>
      !agents.changing(id) &&
      Effect.runSync(agents.list()).some((agent) => agent.id === id),
  );
  const agents = makeAgentService(
    root,
    (id) => !chat.busy(id) && !routines?.busy(id) && !teamwork?.busy(id),
    async (id) => {
      await managedChat.closeAgent(id);
      await browsers.closeAgent(id);
    },
  );
  const providers = makeProviderService(root, options.discoverProviders, () => {
    void broadcast().catch(() => {});
  });
  let routines: ReturnType<typeof makeRoutineService>;
  let teamwork: ReturnType<typeof makeTeamworkService>;
  const managedChat = makeChatRunner(root, providers);
  const runChat = options.runChat ?? managedChat;
  const execute = serializeAgentExecution(async (turn) => {
    if (agents.changing(turn.agentId))
      throw new ChatExecutionError(
        "Agent environment is changing. Retry shortly.",
      );

    teamwork?.validateExecution(
      turn.requestId ?? turn.conversationId,
      turn.agentId,
    );
    await runChat(turn);
  });
  const run: RunChatTurn = (turn) =>
    execute({
      ...turn,
      browserTool: (input) => browsers.tool(turn.agentId, input, turn.signal),
      teamworkTool: (input) =>
        teamwork.tool(turn.agentId, input, turn.conversationId, turn.requestId),
      agentTool: (input) =>
        agentManagement.tool(
          turn.agentId,
          input,
          turn.conversationId === turn.agentId &&
            !teamwork.isConversation(turn.requestId),
        ),
      routineTool: (input) =>
        routines.tool(
          turn.agentId,
          input,
          turn.conversationId !== turn.agentId &&
            !teamwork?.isConversation(turn.conversationId)
            ? turn.conversationId
            : undefined,
        ),
    });
  const chat = makeChatService(root, providers.list, run, () => {
    void broadcast().catch(() => {});
  });
  routines = makeRoutineService(
    root,
    providers.list,
    run,
    chat,
    () => {},
    options.routineLimits ?? routineLimits,
  );
  teamwork = makeTeamworkService(
    root,
    providers.list,
    run,
    chat,
    () => {
      teamworkRevision++;
      void broadcast().catch(() => {});
    },
    agents.changing,
    (id) => {
      try {
        routines.getRun(id);
        return routines.conversations;
      } catch {
        return undefined;
      }
    },
    (agentId) =>
      routines.conversations.list().filter((conversation) => {
        try {
          return routines.getRun(conversation.agentId).agentId === agentId;
        } catch {
          return false;
        }
      }),
  );
  const agentManagement = makeAgentManagementService(
    agents,
    chat,
    (id) =>
      !chat.busy(id) &&
      !routines.busy(id) &&
      !teamwork.busy(id) &&
      !agents.changing(id),
    (id) => {
      chat.invalidateEnvironment(id);
      routines.invalidateEnvironment(id);
      teamwork.invalidateEnvironment(id);
    },
    () => {
      void broadcast().catch(() => {});
    },
  );
  const snapshot = () =>
    Effect.runPromise(agents.list()).then(async (items) => ({
      agents: items,
      teamworkRevision,
      peerWaits: teamwork.replyWaits(),
      teamworkActiveAgentIds: teamwork.activeAgentIds(),
      providers: providers.list(),
      teams: await Effect.runPromise(agents.listTeams()),
      conversations: chat
        .list()
        .map((conversation) => chatHistoryPage(conversation)),
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
      if (await webAssets(request, response, options.webRoot)) return;

      if (await memoryHttp(request, response, makeMemoryService(root))) return;

      if (await routineHttp(request, response, routines)) return;

      if (await peerMessageHttp(request, response, teamwork)) return;

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
          Schema.Struct({
            name: Schema.String,
            value: Schema.String,
            expectedIntegration: TeamIntegration,
          }),
        )(JSON.parse(body));
        const current = (await Effect.runPromise(agents.listTeams()))
          .find((item) => item.id === team.id)
          ?.integrations?.find((item) => item.id === credentials[2]);

        if (
          !current ||
          !isDeepStrictEqual(current, input.expectedIntegration)
        ) {
          response.writeHead(409).end(
            JSON.stringify({
              error:
                "Integration changed. Reload it before saving credentials.",
            }),
          );

          return;
        }

        saveIntegrationSecrets(
          root,
          team.id,
          credentials[2]!,
          {
            [input.name]: input.value,
          },
          input.expectedIntegration,
        );
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
      // prettier-ignore
      if (await chatHttp(
        request,
        response,
        chat,
        teamwork.respond,
      )) return;

      if (request.method === "GET" && request.url === "/api/agents") {
        response.end(JSON.stringify(await snapshot()));

        return;
      }

      const teamId = /^\/api\/teams\/([^/]+)$/.exec(request.url ?? "")?.[1];

      if (request.method === "DELETE" && teamId) {
        const members = (await Effect.runPromise(agents.list())).filter(
          (agent) => agent.teamId === teamId,
        );

        if (members.length) {
          response.writeHead(409).end(
            JSON.stringify({
              error: "Move the team's agents before deleting it.",
            }),
          );

          return;
        }

        const removed = await Effect.runPromise(
          agents.removeTeam(teamId, () => closeNativeMcpLogins(root, teamId)),
        );
        await broadcast();
        response.writeHead(removed ? 204 : 404).end();

        return;
      }

      const agentId = /^\/api\/agents\/([^/]+)$/.exec(request.url ?? "")?.[1];

      if (request.method === "DELETE" && agentId) {
        if (agents.changing(agentId)) {
          response.writeHead(409).end(
            JSON.stringify({
              error: "Agent environment is changing. Retry shortly.",
            }),
          );

          return;
        }

        const removed = await Effect.runPromise(
          agents.remove(agentId, async () => {
            await teamwork.removeAgent(agentId);
            await routines.removeAgent(agentId);
            await chat.remove(agentId);
          }),
        );

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

          if (chat.busy(moveId) || routines.busy(moveId)) {
            response.writeHead(409).end(
              JSON.stringify({
                error: "Only idle agents can move between teams.",
              }),
            );

            return;
          }

          const moved = await Effect.runPromise(agents.moveTeam(moveId, input));
          chat.invalidateEnvironment(moveId);
          routines.invalidateEnvironment(moveId);
          teamwork.invalidateEnvironment(moveId);
          await broadcast();
          response.end(JSON.stringify(moved));

          return;
        }

        if (isTeamCreate || isTeamUpdate) {
          const input = Schema.decodeUnknownSync(
            isTeamCreate ? SaveTeam : UpdateTeam,
          )(JSON.parse(body));
          if (
            input.memory !== undefined &&
            (isTeamUpdate || input.memory !== "")
          ) {
            response.writeHead(403).end(
              JSON.stringify({
                error:
                  "Agents manage memories. Use the memories list to delete entries.",
              }),
            );

            return;
          }

          const team = await Effect.runPromise(agents.saveTeam(input, teamId));

          if (team && input.integrations) {
            await closeNativeMcpLogins(
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
          { onExcessProperty: "error" },
        )(JSON.parse(body));

        if (input.memory !== undefined) {
          response.writeHead(403).end(
            JSON.stringify({
              error:
                "Agents manage memories. Use the memories list to delete entries.",
            }),
          );

          return;
        }

        if (
          updateId &&
          input.sandbox !== undefined &&
          (chat.busy(updateId) || routines.busy(updateId))
        ) {
          response.writeHead(409).end(
            JSON.stringify({
              error: "Only idle agents can change environments.",
            }),
          );

          return;
        }
        const agent = await Effect.runPromise(
          updateId ? agents.update(updateId, input) : agents.create(input),
        );

        if (!agent) {
          response
            .writeHead(404)
            .end(JSON.stringify({ error: "Agent not found" }));

          return;
        }

        if (updateId && input.sandbox !== undefined) {
          chat.invalidateEnvironment(updateId);
          routines.invalidateEnvironment(updateId);
          teamwork.invalidateEnvironment(updateId);
        }

        await broadcast();

        response.writeHead(isCreate ? 201 : 200).end(JSON.stringify(agent));

        return;
      }

      response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      response.writeHead(error instanceof ChatError ? error.status : 400).end(
        JSON.stringify({
          error:
            error instanceof ChatError
              ? error.message
              : "Unable to process request. Check the submitted fields.",
        }),
      );
    }
  });
  // An ingress proxy can forward this dedicated listener without exposing APIs.
  const webhookServer = Http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");

    try {
      if (!(await routineHttp(request, response, routines, true)))
        response.writeHead(404).end();
    } catch {
      if (response.headersSent) response.destroy();
      else
        response
          .writeHead(400)
          .end(JSON.stringify({ error: "Unable to process webhook request." }));
    }
  });
  const sockets = new WebSocketServer({ noServer: true });
  const browserStream = browserSockets(
    server,
    browsers,
    async (id) =>
      !agents.changing(id) &&
      (await Effect.runPromise(agents.list())).some((agent) => agent.id === id),
  );
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") return;

    if (!isAllowedRequestOrigin(request.headers)) {
      socket.destroy();

      return;
    }

    sockets.handleUpgrade(request, socket, head, (client) =>
      sockets.emit("connection", client, request),
    );
  });

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
    webhookServer,
    providers,
    chat,
    routines,
    teamwork,
    close: async () => {
      for (const client of sockets.clients) {
        client.terminate();
      }

      sockets.close();
      browserStream.close();
      server.close();
      webhookServer.close();
      await teamwork.close();
      await routines.close();
      await chat.close();
      await managedChat.close();
      await browsers.close();
      await closeNativeMcpLogins(root);
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
  const app = createServer(root, {
    routineLimits: configuredRoutineLimits(process.env.PAWS_ROUTINE_LIMITS),
    ...(process.env.PAWS_WEB_ROOT
      ? { webRoot: process.env.PAWS_WEB_ROOT }
      : {}),
  });
  app.server.on("error", () => {
    console.error("Paws could not start. Port 4310 may already be in use.");
    process.exit(1);
  });
  const companion = await startCompanion(process.env);
  const host = process.env.PAWS_HOST ?? "127.0.0.1";
  app.server.listen(4310, host, () => {
    console.log(`Paws server: http://${host}:4310`);
    process.send?.({ type: "ready" });
  });

  const close = () => {
    companion?.stop();
    void app.close();
  };
  process.once("disconnect", close);

  if (process.env.PAWS_WEBHOOK_PORT) {
    const port = Number(process.env.PAWS_WEBHOOK_PORT);

    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid PAWS_WEBHOOK_PORT.");

    app.webhookServer.listen(port, "127.0.0.1");
  }

  for (const provider of app.providers.list()) {
    if (
      provider.config.enabled &&
      !["acpRegistry", "antigravity"].includes(provider.config.driver)
    ) {
      void app.providers.refresh(provider.config.id);
    }
  }
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
