import { launchBrowserFixture } from "./browserTestRuntime.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Effect } from "effect";
import { WebSocket } from "ws";
import { expect, it, vi } from "vite-plus/test";
import { makeBrowserService } from "./BrowserService.ts";
import { browserSockets } from "./browserSockets.ts";
import { makeAgentService } from "./AgentService.ts";
import type { BrowserServerMessage, BrowserState } from "@paws/contracts";

it("streams over same-origin sockets, rejects foreign and missing agents, and releases control on disconnect", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-browser-socket-");
  const agents = makeAgentService(root);
  const agent = await Effect.runPromise(agents.create({ name: "Ada" }));
  const browsers = makeBrowserService(root, launchBrowserFixture);
  const server = createServer();
  const sockets = browserSockets(
    server,
    browsers,
    async (id) => id === agent.id,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("No listener.");

  const url = `ws://127.0.0.1:${address.port}/api/agents/${agent.id}/browser/stream`;
  const socket = new WebSocket(url, { origin: "http://localhost:5173" });
  const events: BrowserServerMessage[] = [];
  socket.on("message", (data) => events.push(JSON.parse(data.toString())));
  const latest = () =>
    events.findLast((event): event is BrowserState => event.type === "state");

  try {
    await vi.waitFor(() => expect(latest()?.tabs.length).toBe(1));
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "frame")).toBe(true),
    );
    const tabId = latest()!.tabs[0]!.id;
    socket.send(JSON.stringify({ type: "takeControl", tabId }));
    await vi.waitFor(() => expect(latest()?.controllerTabId).toBe(tabId));
    const signal = AbortSignal.timeout(5000);
    expect(
      (await browsers.tool(agent.id, { action: "snapshot", tabId }, signal))
        .isError,
    ).toBe(true);
    socket.send("not-json");
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "error")).toBe(true),
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);

    for (const [target, origin] of [
      [url, "https://evil.test"],
      [url.replace(agent.id, "missing"), "http://localhost:5173"],
    ]) {
      const rejected = new WebSocket(target!, { origin });
      await expect(once(rejected, "open")).rejects.toThrow();
    }

    const closed = once(socket, "close");
    socket.close();
    await closed;
    await vi.waitFor(async () =>
      expect(
        (await browsers.tool(agent.id, { action: "snapshot", tabId }, signal))
          .isError,
      ).toBeUndefined(),
    );
    await browsers.closeAgent(agent.id);
    expect(
      (await browsers.tool(agent.id, { action: "close", tabId }, signal))
        .isError,
    ).toBe(true);
  } finally {
    socket.terminate();
    sockets.close();
    await browsers.close();
    agents.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

// Exercise viewer disconnect and browser shutdown concurrently across sessions.
it.concurrent.each([1, 2, 3])(
  "opens a human-controlled tab after the last tab is closed [%i]",
  async () => {
    await mkdir("/tmp/codex", { recursive: true });
    const root = await mkdtemp("/tmp/codex/paws-browser-new-tab-");
    const agents = makeAgentService(root);
    const agent = await Effect.runPromise(agents.create({ name: "Ada" }));
    const browsers = makeBrowserService(root, launchBrowserFixture);
    const server = createServer();
    const sockets = browserSockets(
      server,
      browsers,
      async (id) => id === agent.id,
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("No listener.");

    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/agents/${agent.id}/browser/stream`,
      { origin: "http://localhost:5173" },
    );
    const events: BrowserServerMessage[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString())));
    const latest = () =>
      events.findLast((event): event is BrowserState => event.type === "state");

    try {
      await vi.waitFor(() => expect(latest()?.tabs.length).toBe(1));
      const tabId = latest()!.tabs[0]!.id;
      socket.send(JSON.stringify({ type: "takeControl", tabId }));
      await vi.waitFor(() => expect(latest()?.controllerTabId).toBe(tabId));
      socket.send(
        JSON.stringify({
          type: "action",
          generation: latest()!.tabs[0]!.generation,
          input: { action: "close", tabId },
        }),
      );
      await vi.waitFor(() => expect(latest()?.tabs).toHaveLength(0));
      socket.send(
        JSON.stringify({
          type: "action",
          generation: 0,
          input: { action: "open" },
        }),
      );
      await vi.waitFor(() => expect(latest()?.tabs).toHaveLength(1));
      expect(latest()?.controllerTabId).toBe(latest()?.selectedTabId);
      expect(latest()?.selectedTabId).not.toBeNull();
      const replacement = latest()!.selectedTabId;
      await vi.waitFor(() =>
        expect(
          events.some(
            (event) => event.type === "frame" && event.tabId === replacement,
          ),
        ).toBe(true),
      );
      expect(events.filter((event) => event.type === "error")).toEqual([]);
    } finally {
      socket.terminate();
      sockets.close();
      await browsers.close();
      agents.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
