import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import httpProxy from "http-proxy";
import type { Socket } from "node:net";

const cookieName = "__Host-paws";
const login = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Paws</title></head><body><main><h1>Connect to Paws</h1><form method="post" action="/_companion/login"><label>Connection token <input name="token" type="password" required autocomplete="off"></label><button>Connect</button></form></main></body></html>`;

export function createCompanion(options: {
  origin: string;
  token: string;
  target: string;
}) {
  const origin = new URL(options.origin);

  if (origin.protocol !== "https:" || origin.origin !== options.origin)
    throw new Error("PAWS_COMPANION_ORIGIN must be an HTTPS origin.");

  if (!/^[A-Za-z0-9_-]{43,}$/.test(options.token))
    throw new Error("Use a connection token with at least 32 random bytes.");

  const digest = (value: string) => createHash("sha256").update(value).digest();
  const tokenHash = digest(options.token);
  const session = tokenHash.toString("base64url");
  const sign = (expires: string) =>
    createHmac("sha256", options.token).update(expires).digest("base64url");
  const authenticated = (request: IncomingMessage) => {
    const bearer = request.headers.authorization?.match(
      /^Bearer ([0-9]{13})\.([A-Za-z0-9_-]{43})$/,
    );

    if (bearer) {
      return (
        Number(bearer[1]) > Date.now() &&
        timingSafeEqual(digest(bearer[2]!), digest(sign(bearer[1]!)))
      );
    }

    const value = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);

    return !!value && timingSafeEqual(digest(value), digest(session));
  };
  const allowedOrigin = (request: IncomingMessage) =>
    request.headers["sec-fetch-site"] !== "cross-site" &&
    (!request.headers.origin || request.headers.origin === options.origin);
  const proxy = httpProxy.createProxyServer({
    target: options.target,
    changeOrigin: true,
    ws: true,
  });
  const rewrite = (request: import("node:http").ClientRequest) => {
    request.setHeader("origin", options.target);
    request.removeHeader("sec-fetch-site");
    request.removeHeader("cookie");
    request.removeHeader("authorization");
  };
  proxy.on("proxyReq", rewrite);
  proxy.on("proxyReqWs", rewrite);
  proxy.on("error", (_error, _request, response) => {
    if ("writeHead" in response && !response.headersSent)
      response.writeHead(502).end("Paws is unavailable. Retry shortly.");
    else response.destroy();
  });
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");

    if (!allowedOrigin(request) || !request.url?.startsWith("/")) {
      response.writeHead(403).end("Origin not allowed");

      return;
    }

    if (
      ["/_companion/login", "/_companion/session"].includes(request.url) &&
      request.method === "POST"
    ) {
      if (request.headers.origin !== options.origin) {
        response.writeHead(403).end();

        return;
      }

      let body = "";

      try {
        for await (const chunk of request) {
          body += chunk.toString();

          if (body.length > 4096) {
            response.writeHead(413).end();

            return;
          }
        }
      } catch {
        response.destroy();

        return;
      }

      const token = new URLSearchParams(body).get("token") ?? "";

      if (!timingSafeEqual(digest(token), tokenHash)) {
        response.writeHead(401).end("Incorrect token. Go back and retry.");

        return;
      }

      if (request.url === "/_companion/session") {
        const expires = String(Date.now() + 86_400_000);
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({ session: `${expires}.${sign(expires)}` }),
        );

        return;
      }

      response
        .writeHead(303, {
          Location: "/",
          "Set-Cookie": `${cookieName}=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
        })
        .end();

      return;
    }

    if (!authenticated(request)) {
      if (request.headers.authorization) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ error: "Session expired. Connect again." }),
        );

        return;
      }

      response
        .writeHead(request.method === "GET" ? 200 : 401, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
        })
        .end(login);

      return;
    }

    if (
      !["GET", "HEAD"].includes(request.method ?? "") &&
      request.headers.origin !== options.origin
    ) {
      response.writeHead(403).end();

      return;
    }

    proxy.web(request, response);
  });
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    if (
      !authenticated(request) ||
      !allowedOrigin(request) ||
      request.headers.origin !== options.origin
    ) {
      socket.destroy();

      return;
    }

    proxy.ws(request, socket, head);
  });
  server.on("close", () => proxy.close());

  return Object.assign(server, {
    stop: () => {
      for (const socket of connections) socket.destroy();

      server.close();
      proxy.close();
    },
  });
}

export async function startCompanion(env: NodeJS.ProcessEnv) {
  if (!env.PAWS_COMPANION_ORIGIN && !env.PAWS_COMPANION_TOKEN_FILE)
    return undefined;

  if (!env.PAWS_COMPANION_ORIGIN || !env.PAWS_COMPANION_TOKEN_FILE)
    throw new Error(
      "Set both PAWS_COMPANION_ORIGIN and PAWS_COMPANION_TOKEN_FILE.",
    );

  const server = createCompanion({
    origin: env.PAWS_COMPANION_ORIGIN,
    token: (await readFile(env.PAWS_COMPANION_TOKEN_FILE, "utf8")).trim(),
    target: "http://127.0.0.1:4310",
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(4311, env.PAWS_COMPANION_HOST ?? "127.0.0.1", resolve);
  });

  return server;
}
