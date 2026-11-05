import { afterEach, expect, it, vi } from "vite-plus/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Effect } from "effect";
import { createServer } from "./main.ts";
import { launchBrowserFixture } from "./browserTestRuntime.ts";
import {
  makeEnvironmentService,
  environmentUrl,
} from "./EnvironmentService.ts";
import { tailscaleAddresses } from "./environmentDiscovery.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function root() {
  await mkdir("/tmp/codex", { recursive: true });
  const path = await mkdtemp("/tmp/codex/paws-environments-");
  cleanups.push(() => rm(path, { recursive: true, force: true }));

  return path;
}

async function machine() {
  const app = createServer(await root(), {
    environmentPort: 0,
    launchBrowser: launchBrowserFixture,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  cleanups.push(() => app.close());
  const address = app.server.address();

  if (!address || typeof address === "string") throw new Error("Missing port");

  const url = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, method = "GET", input?: unknown) =>
    fetch(url + path, {
      method,
      ...(input === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }),
    });

  return { app, url, request };
}

it("persists identity and links, consumes and expires codes, and revokes access", async () => {
  const path = await root();
  let now = 1000;
  let service = makeEnvironmentService(path, () => now);
  const identity = service.identity();
  const peer = { id: "peer", name: "Laptop", platform: "linux" };
  await Effect.runPromise(
    service.configure({ name: "Desktop", sharing: true }),
  );
  const expired = await Effect.runPromise(service.createPairing());
  now += 300_001;
  await expect(
    Effect.runPromise(service.pair(expired.code, peer)),
  ).rejects.toThrow("expired");
  const { code } = await Effect.runPromise(service.createPairing());
  await expect(Effect.runPromise(service.pair("wrong", peer))).rejects.toThrow(
    "incorrect",
  );
  const paired = await Effect.runPromise(service.pair(code, peer));
  expect(service.authorize(paired.token)).toBe(true);
  await expect(Effect.runPromise(service.pair(code, peer))).rejects.toThrow(
    "expired",
  );
  await Effect.runPromise(
    service.remember({
      ...peer,
      url: "http://127.0.0.1:4312",
      token: "private",
    }),
  );
  await Effect.runPromise(service.setEnabled(peer.id, false));
  service.close();
  service = makeEnvironmentService(path, () => now);

  try {
    expect(service.identity()).toEqual({ ...identity, name: "Desktop" });
    expect(service.list()[0]?.token).toBe("private");
    expect(service.list()[0]?.enabled).toBe(false);
    await Effect.runPromise(service.setEnabled(peer.id, true));
    expect(service.list()[0]?.enabled).toBe(true);
    expect(service.authorize(paired.token)).toBe(true);
    await Effect.runPromise(service.revoke(peer.id));
    expect(service.authorize(paired.token)).toBe(false);
    await Effect.runPromise(service.forget(peer.id));
    expect(service.list()).toEqual([]);
  } finally {
    service.close();
  }
});

it("links two servers and routes HTTP, attachments and WebSockets to the selected environment", async () => {
  const local = await machine();
  const remote = await machine();
  const sharedResponse = await remote.request("/api/environments", "PATCH", {
    sharing: true,
    name: "Remote",
  });
  expect(sharedResponse.status).toBe(200);
  const shared = await sharedResponse.json();
  const gateway = `http://127.0.0.1:${shared.port}`;
  expect((await fetch(gateway + "/api/agents")).status).toBe(401);
  expect(
    (
      await fetch(gateway + "/identity", {
        headers: { origin: "https://evil.test" },
      })
    ).status,
  ).toBe(403);
  const pairing = await (
    await remote.request("/api/environments/pairing", "POST")
  ).json();
  const linkResponse = await local.request("/api/environments/link", "POST", {
    url: gateway,
    code: pairing.code,
    expectedId: shared.local.id,
  });
  expect(linkResponse.status).toBe(200);
  const linked = await linkResponse.json();
  expect(linked.linked).toEqual([{ ...shared.local, url: gateway }]);
  expect(JSON.stringify(linked)).not.toContain("token");
  const base = `/api/environments/${shared.local.id}/proxy`;
  const created = await local.request(base + "/api/agents", "POST", {
    name: "Remote agent",
  });
  expect(created.status).toBe(201);
  const agent = await created.json();
  expect(await (await local.request("/api/agents")).json()).toMatchObject({
    agents: [],
  });
  expect(await (await remote.request("/api/agents")).json()).toMatchObject({
    agents: [agent],
  });
  const upload = await fetch(
    local.url + base + `/api/agents/${agent.id}/chat/uploads`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": "example.txt",
      },
      body: "remote bytes",
    },
  );
  expect(upload.status).toBe(201);
  const attachment = await upload.json();
  expect(
    await (
      await local.request(
        base + `/api/agents/${agent.id}/chat/attachments/${attachment.id}`,
      )
    ).text(),
  ).toBe("remote bytes");
  expect((await local.request(base + "/api/environments")).status).toBe(404);
  const socket = new WebSocket(
    local.url.replace("http:", "ws:") + base + "/ws",
  );
  cleanups.push(async () => {
    socket.terminate();
  });
  const [data] = await once(socket, "message");
  expect(JSON.parse(String(data))).toMatchObject({ agents: [agent] });
  const browser = new WebSocket(
    local.url.replace("http:", "ws:") +
      base +
      `/api/agents/${agent.id}/browser/stream`,
  );
  cleanups.push(async () => {
    browser.terminate();
  });
  const updates: { type: string }[] = [];
  browser.on("message", (message) => updates.push(JSON.parse(String(message))));
  await vi.waitFor(
    () => expect(updates.some((update) => update.type === "frame")).toBe(true),
    { timeout: 10_000 },
  );
  const browserClosed = once(browser, "close");
  const closed = once(socket, "close");
  await remote.request(
    `/api/environments/connections/${linked.local.id}`,
    "DELETE",
  );
  await Promise.all([closed, browserClosed]);
  expect((await local.request(base + "/api/agents")).status).toBe(401);
});

it("disables sharing, preserves links, and refuses identity mismatches and self linking", async () => {
  const local = await machine();
  const shared = await (
    await local.request("/api/environments", "PATCH", { sharing: true })
  ).json();
  const gateway = `http://127.0.0.1:${shared.port}`;
  expect(
    (
      await local.request("/api/environments/link", "POST", {
        url: gateway,
        code: "wrong",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await local.request("/api/environments/link", "POST", {
        url: gateway,
        code: "wrong",
        expectedId: "different",
      })
    ).status,
  ).toBe(400);
  await local.request("/api/environments", "PATCH", { sharing: false });
  await expect(fetch(gateway + "/identity")).rejects.toThrow();
});

it("validates addresses and only discovers online Tailscale peer IPs", () => {
  expect(environmentUrl("http://192.168.1.2:4312/")).toBe(
    "http://192.168.1.2:4312",
  );

  for (const url of [
    "file:///etc/passwd",
    "http://user:secret@host",
    "http://host/api/agents",
    "http://host/#fragment",
  ]) {
    expect(() => environmentUrl(url)).toThrow();
  }

  expect(
    tailscaleAddresses({
      BackendState: "Running",
      Peer: {
        first: {
          Online: true,
          TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1", "not-an-ip"],
        },
        duplicate: { Online: true, TailscaleIPs: ["100.64.0.1"] },
        offline: { Online: false, TailscaleIPs: ["100.64.0.2"] },
      },
    }),
  ).toEqual(["100.64.0.1", "fd7a:115c:a1e0::1"]);
  expect(() => tailscaleAddresses({ BackendState: "Stopped" })).toThrow(
    "not connected",
  );
});

it("pauses saved connections, closes their streams, rejects disabled requests, and resumes without re-pairing", async () => {
  const local = await machine();
  const remote = await machine();
  const shared = await (
    await remote.request("/api/environments", "PATCH", { sharing: true })
  ).json();
  const pairing = await (
    await remote.request("/api/environments/pairing", "POST")
  ).json();
  const linked = await (
    await local.request("/api/environments/link", "POST", {
      url: `http://127.0.0.1:${shared.port}`,
      code: pairing.code,
    })
  ).json();
  const peerId = linked.linked[0].id;
  const path = `/api/environments/links/${peerId}`;
  const proxy = `/api/environments/${peerId}/proxy`;
  const socketUrl = local.url.replace("http:", "ws:") + proxy + "/ws";
  const socket = new WebSocket(socketUrl);
  cleanups.push(async () => {
    socket.terminate();
  });
  await once(socket, "message");
  const closed = once(socket, "close");
  const disabled = await local.request(path, "PATCH", { enabled: false });
  expect(disabled.status).toBe(200);
  expect((await disabled.json()).linked[0]).toMatchObject({
    id: peerId,
    enabled: false,
  });
  await closed;
  expect((await local.request(proxy + "/api/agents")).status).toBe(404);
  const rejected = new WebSocket(socketUrl);
  await expect(once(rejected, "open")).rejects.toThrow();
  expect((await local.request(path, "PATCH", { enabled: "yes" })).status).toBe(
    400,
  );
  expect(
    (
      await local.request("/api/environments/links/missing", "PATCH", {
        enabled: true,
      })
    ).status,
  ).toBe(400);
  const enabled = await local.request(path, "PATCH", { enabled: true });
  expect(enabled.status).toBe(200);
  expect((await enabled.json()).linked[0]).toMatchObject({
    id: peerId,
    enabled: true,
  });
  expect((await local.request(proxy + "/api/agents")).status).toBe(200);
  const resumed = new WebSocket(socketUrl);
  cleanups.push(async () => {
    resumed.terminate();
  });
  const [data] = await once(resumed, "message");
  expect(JSON.parse(String(data))).toMatchObject({ agents: [] });
});
