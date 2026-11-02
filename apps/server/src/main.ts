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
import { stopEnvironment } from "@paws/runtime";
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
import { makeChatService } from "./ChatService.ts";
import { makeChatRunner } from "./chatRunner.ts";
import { chatHttp } from "./chatHttp.ts";
import { ChatExecutionError, type RunChatTurn } from "@paws/provider-core";

export function createServer(
  root: string,
  options: {
    runChat?: RunChatTurn;
    routineLimits?: typeof routineLimits;
    discoverProviders?: Parameters<typeof makeProviderService>[1];
  } = {},
) {
  const agents = makeAgentService(
    root,
    (id) => !chat.busy(id) && !routines?.busy(id),
  );
  const providers = makeProviderService(root, options.discoverProviders, () => {
    void broadcast().catch(() => {});
  });
  let routines: ReturnType<typeof makeRoutineService>;
  const runChat = options.runChat ?? makeChatRunner(root, providers);
  const execute = serializeAgentExecution(async (turn) => {
    if (agents.changing(turn.agentId))
      throw new ChatExecutionError(
        "Agent environment is changing. Retry shortly.",
      );

    await runChat(turn);
  });
  const run: RunChatTurn = (turn) =>
    execute({
      ...turn,
      routineTool: (input) =>
        routines.tool(
          turn.agentId,
          input,
          turn.conversationId !== turn.agentId
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
      if (await routineHttp(request, response, routines)) return;

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
      if (await chatHttp(request, response, chat)) return;

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

        const removed = await Effect.runPromise(agents.removeTeam(teamId));
        await closeNativeMcpLogins(root, teamId);

        if (removed) await stopEnvironment(root, teamId, "team");
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

        const exists = (await Effect.runPromise(agents.list())).some(
          (agent) => agent.id === agentId,
        );

        if (exists) {
          await routines.removeAgent(agentId);
          await chat.remove(agentId);
        }

        const removed = await Effect.runPromise(agents.remove(agentId));

        if (!removed) {
          response
            .writeHead(404)
            .end(JSON.stringify({ error: "Agent not found" }));

          return;
        }

        await stopEnvironment(root, agentId, "agent");
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
          await broadcast();
          response.end(JSON.stringify(moved));

          return;
        }

        if (isTeamCreate || isTeamUpdate) {
          const input = Schema.decodeUnknownSync(
            isTeamCreate ? SaveTeam : UpdateTeam,
          )(JSON.parse(body));
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
        }

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
    webhookServer,
    providers,
    chat,
    routines,
    close: async () => {
      for (const client of sockets.clients) {
        client.terminate();
      }

      sockets.close();
      server.close();
      webhookServer.close();
      await routines.close();
      await chat.close();
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
  });
  app.server.listen(4310, "127.0.0.1", () =>
    console.log("Paws server: http://127.0.0.1:4310"),
  );
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
  process.once("SIGINT", app.close);
  process.once("SIGTERM", app.close);
}
