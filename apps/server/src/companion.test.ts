import { afterEach, expect, it } from "vite-plus/test";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createCompanion } from "./companion.ts";

const servers: Server[] = [];
const sockets: WebSocket[] = [];
const origin = "https://paws.example.test";

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();

  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("No port");

  return `http://127.0.0.1:${address.port}`;
}

async function fixture() {
  let requests = 0;
  const target = createServer((request, response) => {
    requests++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.headers));
  });
  const ws = new WebSocketServer({ server: target });
  ws.on("connection", (socket, request) => {
    sockets.push(socket);
    socket.send(JSON.stringify(request.headers));
  });
  const targetUrl = await listen(target);
  const token = randomBytes(32).toString("base64url");
  const companion = createCompanion({ origin, token, target: targetUrl });
  const gateway = await listen(companion);
  const login = (value = token) =>
    fetch(`${gateway}/_companion/login`, {
      method: "POST",
      headers: { origin },
      body: new URLSearchParams({ token: value }),
      redirect: "manual",
    });
  const response = await login();
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;

  return {
    gateway,
    targetUrl,
    target,
    companion,
    login,
    cookie,
    requests: () => requests,
  };
}

it("shuts down upgraded connections", async () => {
  const { gateway, cookie, companion } = await fixture();
  const socket = new WebSocket(gateway.replace("http:", "ws:") + "/ws", {
    origin,
    headers: { cookie },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  companion.stop();
  await closed;
});

it("reports an unavailable backend without exposing internal errors", async () => {
  const { gateway, cookie, target } = await fixture();
  target.closeAllConnections();
  await new Promise<void>((resolve) => target.close(() => resolve()));
  const response = await fetch(gateway, { headers: { cookie } });
  expect(response.status).toBe(502);
  expect(await response.text()).toBe("Paws is unavailable. Retry shortly.");
});

it("protects reads and writes, rejects wrong tokens and cross-origin requests", async () => {
  const fixture_ = await fixture();
  const { gateway, cookie } = fixture_;
  expect((await fixture_.login("incorrect")).status).toBe(401);
  expect(await (await fetch(`${gateway}/api/agents`)).text()).toContain(
    "Connection token",
  );
  expect(
    (await fetch(`${gateway}/api/agents`, { method: "POST" })).status,
  ).toBe(401);
  expect(
    (await fetch(gateway, { headers: { cookie, origin: "https://evil.test" } }))
      .status,
  ).toBe(403);
  expect(
    (
      await fetch(`${gateway}/api/agents`, {
        method: "POST",
        headers: { cookie },
      })
    ).status,
  ).toBe(403);
  expect(fixture_.requests()).toBe(0);
});

it("sets a secure session and forwards authenticated requests without credentials", async () => {
  const { gateway, login, cookie, targetUrl } = await fixture();
  const signedIn = await login();
  expect(signedIn.status).toBe(303);
  expect(signedIn.headers.get("set-cookie")).toContain(
    "HttpOnly; Secure; SameSite=Strict",
  );
  const response = await fetch(`${gateway}/api/agents`, {
    method: "POST",
    headers: { cookie, origin, authorization: "Bearer private" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ origin: targetUrl });
  const headers = await (await fetch(gateway, { headers: { cookie } })).json();
  expect(headers.cookie).toBeUndefined();
  expect(headers.authorization).toBeUndefined();
});

it("authenticates both snapshot and browser-stream WebSocket upgrades", async () => {
  const { gateway, cookie, targetUrl } = await fixture();

  for (const path of ["/ws", "/api/agents/test/browser/stream"]) {
    const url = gateway.replace("http:", "ws:") + path;
    const denied = new WebSocket(url, { origin });
    sockets.push(denied);
    await new Promise<void>((resolve) => denied.once("error", () => resolve()));
    const allowed = new WebSocket(url, { origin, headers: { cookie } });
    sockets.push(allowed);
    const message = await new Promise<string>((resolve, reject) => {
      allowed.once("error", reject);
      allowed.once("message", (data) => resolve(data.toString()));
    });
    expect(JSON.parse(message)).toMatchObject({ origin: targetUrl });
    expect(JSON.parse(message).cookie).toBeUndefined();
    allowed.terminate();
  }
});

it("refuses insecure companion configuration", () => {
  expect(() =>
    createCompanion({
      origin: "http://example.test",
      token: "x",
      target: "http://localhost",
    }),
  ).toThrow("HTTPS");
  expect(() =>
    createCompanion({ origin, token: "x", target: "http://localhost" }),
  ).toThrow("random bytes");
});
