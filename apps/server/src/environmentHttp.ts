import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import { Effect, Schema } from "effect";
import {
  EnvironmentIdentity,
  PairEnvironment,
  type EnvironmentState,
} from "@paws/contracts";
import {
  environmentUrl,
  makeEnvironmentService,
} from "./EnvironmentService.ts";
import {
  localEnvironmentAddresses,
  makeEnvironmentDiscovery,
} from "./environmentDiscovery.ts";

const prefix = /^\/api\/environments\/([^/]+)\/proxy(\/.*)$/;
const pairResult = Schema.Struct({
  identity: EnvironmentIdentity,
  token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
const identityInput = Schema.Struct({
  code: Schema.String,
  identity: EnvironmentIdentity,
  expectedId: Schema.String,
});
const configInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  sharing: Schema.optional(Schema.Boolean),
});

async function body(request: IncomingMessage) {
  if (request.headers["content-type"] !== "application/json")
    throw new Error("Expected application/json.");

  let data = "";

  for await (const chunk of request) {
    data += chunk;

    if (Buffer.byteLength(data) > 4096) throw new Error("Request too large.");
  }

  return JSON.parse(data);
}

function allowedPath(path: string) {
  if (
    path !== "/ws" &&
    !/^\/api\/(agents|teams|providers|routine-runs|routine-preview)(\/|\?|$)/.test(
      path,
    )
  )
    return false;

  return (
    new URL(path, "http://localhost").pathname === path.split("?")[0] &&
    !path.includes("#") &&
    !path.includes("\\")
  );
}

export function makeEnvironmentHttp(
  root: string,
  server: Server,
  options: { port?: number; networking?: boolean } = {},
) {
  const service = makeEnvironmentService(root);
  let gateway: Server | undefined;
  let closing = false;
  let sharedPort = options.port ?? 4312;
  let starting: Promise<void> | undefined;
  let configuration = Promise.resolve();
  const sessions = new Set<{
    socket: Duplex;
    token?: string;
    peerId?: string;
  }>();
  const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });
  const discovery = makeEnvironmentDiscovery(service.identity, () =>
    gateway?.listening && service.sharing() ? sharedPort : undefined,
  );

  const localTarget = () => {
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("Paws is not listening.");

    return `http://127.0.0.1:${address.port}`;
  };
  // Never pass browser cookies or caller-supplied credentials to another machine.

  const rewrite = (
    outgoing: import("node:http").ClientRequest,
    incoming: IncomingMessage,
  ) => {
    outgoing.removeHeader("cookie");
    outgoing.removeHeader("authorization");
    outgoing.removeHeader("sec-fetch-site");
    outgoing.removeHeader("forwarded");
    outgoing.removeHeader("x-forwarded-for");
    outgoing.removeHeader("x-forwarded-host");
    outgoing.removeHeader("origin");
    const match = prefix.exec(incoming.url ?? "");

    if (match) {
      const link = service.list().find((item) => item.id === match[1]);

      if (link) outgoing.setHeader("authorization", `Bearer ${link.token}`);
    }
  };
  proxy.on("proxyReq", rewrite);
  proxy.on("proxyReqWs", rewrite);
  proxy.on("proxyRes", (response) => {
    delete response.headers["set-cookie"];
  });
  proxy.on("error", (_error, _request, response) => {
    if ("writeHead" in response && !response.headersSent)
      response.writeHead(502).end(
        JSON.stringify({
          error:
            "Environment is unavailable. Check its address and connection.",
        }),
      );
    else response.destroy();
  });

  const track = (
    socket: Duplex,
    details: { token?: string; peerId?: string },
  ) => {
    const session = { socket, ...details };
    sessions.add(session);
    socket.once("close", () => sessions.delete(session));
  };

  const disconnect = (peerId?: string) => {
    for (const session of sessions) {
      if (
        !peerId ||
        session.peerId === peerId ||
        (session.token && !service.authorize(session.token))
      )
        session.socket.destroy();
    }
  };

  const token = (request: IncomingMessage) =>
    request.headers.authorization?.replace(/^Bearer /, "") ?? "";

  const forwardLocal = (request: IncomingMessage, response: ServerResponse) =>
    proxy.web(request, response, { target: localTarget() });

  const stopSharing = () => {
    const current = gateway;
    gateway = undefined;
    for (const session of sessions) {
      if (session.token) session.socket.destroy();
    }

    current?.closeAllConnections();
    current?.close();
  };

  const startSharing = async () => {
    if (gateway?.listening) return;
    if (starting) return starting;

    starting = (async () => {
      const current = createServer(async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");

        if (
          !service.sharing() ||
          request.headers.origin ||
          request.headers["sec-fetch-site"] === "cross-site"
        ) {
          response.writeHead(403).end();

          return;
        }

        try {
          if (request.url === "/identity" && request.method === "GET") {
            response.end(JSON.stringify(service.identity()));

            return;
          }

          if (request.url === "/pair" && request.method === "POST") {
            const input = Schema.decodeUnknownSync(identityInput)(
              await body(request),
            );

            if (input.expectedId !== service.identity().id)
              throw new Error(
                "Environment identity changed. Discover it again.",
              );

            const paired = await Effect.runPromise(
              service.pair(input.code, input.identity),
            );
            disconnect(input.identity.id);
            response.end(JSON.stringify(paired));

            return;
          }

          if (!service.authorize(token(request))) {
            response.writeHead(401).end(
              JSON.stringify({
                error: "Connection revoked. Pair this environment again.",
              }),
            );

            return;
          }

          if (!allowedPath(request.url ?? "") || request.url === "/ws") {
            response.writeHead(404).end();

            return;
          }

          forwardLocal(request, response);
        } catch {
          response.writeHead(400).end(
            JSON.stringify({
              error:
                "Pairing failed. Check the code and environment identity, then retry.",
            }),
          );
        }
      });
      current.requestTimeout = 10_000;
      current.headersTimeout = 10_000;
      current.on("upgrade", (request, socket, head) => {
        const bearer = token(request);

        if (
          !service.authorize(bearer) ||
          request.headers.origin ||
          !allowedPath(request.url ?? "")
        ) {
          socket.destroy();

          return;
        }

        track(socket, { token: bearer });
        proxy.ws(request, socket, head, { target: localTarget() });
      });
      gateway = current;

      try {
        await new Promise<void>((resolve, reject) => {
          current.once("error", reject);
          current.listen(sharedPort, "0.0.0.0", resolve);
        });
        const address = current.address();

        if (address && typeof address !== "string") sharedPort = address.port;
        if (closing) stopSharing();
      } catch {
        stopSharing();

        throw new Error(
          "Could not start environment sharing. Check whether its port is already in use.",
        );
      }
    })();

    try {
      await starting;
    } finally {
      starting = undefined;
    }
  };

  const state = (): EnvironmentState => ({
    local: service.identity(),
    sharing: service.sharing() && !!gateway?.listening,
    port: sharedPort,
    addresses: localEnvironmentAddresses(sharedPort),
    linked: service.list().map(({ token: _token, ...link }) => link),
    connections: service.connections(),
    discoveryError: discovery.error(),
  });

  const http = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "";
    const remote = prefix.exec(path);

    if (remote) {
      const link = service.list().find((item) => item.id === remote[1]);

      if (
        !link ||
        link.enabled === false ||
        !allowedPath(remote[2]!) ||
        remote[2] === "/ws"
      ) {
        response.writeHead(404).end();
      } else {
        proxy.web(request, response, {
          target: link.url + remote[2],
          ignorePath: true,
        });
      }

      return true;
    }

    if (!path.startsWith("/api/environments")) return false;

    response.setHeader("Cache-Control", "no-store");

    try {
      if (path === "/api/environments" && request.method === "GET") {
        response.end(JSON.stringify(state()));
      } else if (path === "/api/environments" && request.method === "PATCH") {
        const input = Schema.decodeUnknownSync(configInput)(
          await body(request),
        );

        if (
          input.name !== undefined &&
          (!input.name.trim() || input.name.trim().length > 80)
        )
          throw new Error("Use a name of 1–80 characters.");

        const pending = configuration.then(async () => {
          if (input.sharing === true) await startSharing();

          await Effect.runPromise(service.configure(input));

          if (input.sharing === false) stopSharing();
        });
        configuration = pending.catch(() => {});
        await pending;

        response.end(JSON.stringify(state()));
      } else if (
        path === "/api/environments/discover" &&
        request.method === "POST"
      ) {
        response.end(JSON.stringify(await discovery.discover()));
      } else if (
        path === "/api/environments/pairing" &&
        request.method === "POST"
      ) {
        response.end(
          JSON.stringify(await Effect.runPromise(service.createPairing())),
        );
      } else if (
        path === "/api/environments/link" &&
        request.method === "POST"
      ) {
        const input = Schema.decodeUnknownSync(PairEnvironment)(
          await body(request),
        );
        const url = environmentUrl(input.url);
        const identityResponse = await fetch(`${url}/identity`, {
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        });
        const peer = Schema.decodeUnknownSync(EnvironmentIdentity)(
          await identityResponse.json(),
        );

        if (
          !identityResponse.ok ||
          (input.expectedId && input.expectedId !== peer.id)
        )
          throw new Error("Environment identity changed. Discover it again.");
        if (peer.id === service.identity().id)
          throw new Error("This is the current environment.");

        const result = await fetch(`${url}/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: input.code,
            identity: service.identity(),
            expectedId: peer.id,
          }),
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        });

        if (!result.ok)
          throw new Error(
            "Pairing failed. Create a new code on the other computer and retry.",
          );

        const paired = Schema.decodeUnknownSync(pairResult)(
          await result.json(),
        );

        if (paired.identity.id !== peer.id)
          throw new Error("Environment identity changed. Discover it again.");

        await Effect.runPromise(
          service.remember({ ...paired.identity, url, token: paired.token }),
        );
        response.end(JSON.stringify(state()));
      } else {
        const remove =
          /^\/api\/environments\/(links|connections)\/([^/]+)$/.exec(path);

        if (remove?.[1] === "links" && request.method === "PATCH") {
          const input = Schema.decodeUnknownSync(
            Schema.Struct({ enabled: Schema.Boolean }),
          )(await body(request));
          await Effect.runPromise(
            service.setEnabled(remove[2]!, input.enabled),
          );
          disconnect(remove[2]);
          response.end(JSON.stringify(state()));
        } else if (remove && request.method === "DELETE") {
          await Effect.runPromise(
            remove[1] === "links"
              ? service.forget(remove[2]!)
              : service.revoke(remove[2]!),
          );
          disconnect(remove[2]);
          response.end(JSON.stringify(state()));
        } else response.writeHead(404).end();
      }
    } catch (error) {
      response.writeHead(400).end(
        JSON.stringify({
          error:
            error instanceof Error
              ? error.message
              : "Could not update environments. Retry.",
        }),
      );
    }

    return true;
  };

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const remote = prefix.exec(request.url ?? "");

    if (!remote) {
      socket.destroy();

      return;
    }

    const link = service.list().find((item) => item.id === remote[1]);

    if (!link || link.enabled === false || !allowedPath(remote[2]!)) {
      socket.destroy();

      return;
    }

    track(socket, { peerId: link.id });
    proxy.ws(request, socket, head, {
      target: link.url + remote[2],
      ignorePath: true,
    });
  };
  server.on("listening", () => {
    if (options.networking) discovery.start();
    if (service.sharing()) void startSharing().catch(() => {});
  });

  return {
    http,
    upgrade,
    close: async () => {
      closing = true;
      await configuration;
      await starting?.catch(() => {});
      stopSharing();
      disconnect();
      discovery.close();
      proxy.close();
      service.close();
    },
  };
}
