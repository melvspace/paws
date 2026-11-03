import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { makeAgentService } from "./AgentService.ts";
import { browserUrl, makeBrowserService } from "./BrowserService.ts";
import { launchBrowserFixture } from "./browserTestRuntime.ts";
import { launchAgentBrowser } from "./browserRuntime.ts";
import type { BrowserServerMessage, BrowserState } from "@paws/contracts";

async function fixture() {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-browser-");
  const agents = makeAgentService(root);
  const agent = await Effect.runPromise(agents.create({ name: "Ada" }));
  const other = await Effect.runPromise(agents.create({ name: "Grace" }));
  const launch = vi.fn(launchBrowserFixture);
  const browsers = makeBrowserService(root, launch);
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<title>Browser fixture</title><label>Name<input id="name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Greet</button><output></output><a href="/next">Next</a><button onclick="window.open('/popup')">Popup</button><button onclick="confirm('Continue?')">Confirm</button><div style="height:1800px">Scroll</div>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("No fixture port.");

  const url = `http://127.0.0.1:${address.port}`;
  const signal = AbortSignal.timeout(20000);
  const tool = (input: unknown, id = agent.id) =>
    browsers.tool(id, input, signal);

  return {
    root,
    agent,
    other,
    browsers,
    launch,
    url,
    tool,
    async close() {
      await browsers.close();
      agents.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function latestState(events: BrowserServerMessage[]) {
  const state = events.findLast(
    (event): event is BrowserState => event.type === "state",
  );

  if (!state) throw new Error("No browser state.");

  return state;
}

it("runs real browser tools, preserves cookies, isolates agents, and cleans up", async () => {
  const f = await fixture();

  try {
    const [first, concurrent] = await Promise.all([
      f.tool({ action: "list" }),
      f.tool({ action: "list" }),
    ]);
    expect(first.isError).toBeUndefined();
    expect(concurrent.isError).toBeUndefined();
    expect(f.launch).toHaveBeenCalledTimes(1);
    const events: BrowserServerMessage[] = [];
    const viewer = await f.browsers.attach(
      f.agent.id,
      (event) => events.push(event),
      () => {},
    );
    const tabId = latestState(events).tabs[0]!.id;
    await f.tool({ action: "navigate", tabId, url: f.url });
    await f.tool({ action: "fill", tabId, selector: "#name", text: "Ada" });
    await f.tool({
      action: "click",
      tabId,
      selector: 'role=button[name="Greet"]',
    });
    expect(
      JSON.stringify(await f.tool({ action: "snapshot", tabId })),
    ).toContain("Ada");
    const screenshot = await f.tool({ action: "screenshot", tabId });
    expect(screenshot.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(
      JSON.stringify(await f.tool({ action: "snapshot", tabId }, f.other.id)),
    ).toContain("tab not found");
    const runtime = await f.launch.mock.results[0]!.value;
    await runtime.context.addCookies([
      {
        name: "paws-test",
        value: "retained",
        url: f.url,
        expires: Date.now() / 1000 + 3600,
      },
    ]);
    const otherRuntime = await f.launch.mock.results[1]!.value;
    expect(await otherRuntime.context.cookies()).toEqual([]);
    await viewer.detach();
    await f.browsers.closeAgent(f.agent.id);
    await f.tool({ action: "list" });
    const resumed = await f.launch.mock.results[2]!.value;
    expect(await resumed.context.cookies(f.url)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "paws-test", value: "retained" }),
      ]),
    );
  } finally {
    await f.close();
  }
}, 30000);

it("streams real frames and enforces takeover, stale input, and disconnect cleanup", async () => {
  const f = await fixture();
  const first: BrowserServerMessage[] = [];
  const second: BrowserServerMessage[] = [];

  try {
    const one = await f.browsers.attach(
      f.agent.id,
      (event) => first.push(event),
      () => {},
    );
    const two = await f.browsers.attach(
      f.agent.id,
      (event) => second.push(event),
      () => {},
    );
    const tabId = latestState(first).tabs[0]!.id;
    await f.tool({ action: "navigate", tabId, url: f.url });
    await vi.waitFor(() =>
      expect(first.some((event) => event.type === "frame")).toBe(true),
    );
    expect(latestState(first)).toMatchObject({ width: 1280, height: 800 });
    await one.input({ type: "takeControl", tabId });
    expect(latestState(first).controllerTabId).toBe(tabId);
    expect(latestState(second).controllerTabId).toBeNull();
    const generation = latestState(first).tabs[0]!.generation;

    for (const action of ["snapshot", "screenshot", "close", "reload"]) {
      expect((await f.tool({ action, tabId })).isError).toBe(true);
    }

    await expect(
      two.input({
        type: "action",
        generation,
        input: { action: "reload", tabId },
      }),
    ).rejects.toThrow("Control changed");
    await one.input({
      type: "pointer",
      tabId,
      generation,
      x: 90,
      y: 18,
      phase: "down",
      button: "left",
    });
    await one.input({
      type: "pointer",
      tabId,
      generation,
      x: 90,
      y: 18,
      phase: "up",
      button: "left",
    });
    await one.input({ type: "text", tabId, generation, text: "Human" });
    const runtime = await f.launch.mock.results[0]!.value;
    expect(
      await runtime.context.pages()[0]!.locator("input").inputValue(),
    ).toBe("Human");
    await one.input({
      type: "key",
      tabId,
      generation,
      key: "Shift",
      phase: "down",
    });
    // A second viewer can take over, but cannot use the old lease or release another viewer.
    await two.input({ type: "takeControl", tabId });
    await expect(
      one.input({ type: "key", tabId, generation, key: "x", phase: "down" }),
    ).rejects.toThrow("Control changed");
    await expect(one.input({ type: "releaseControl", tabId })).rejects.toThrow(
      "current controller",
    );
    await two.detach();
    expect(latestState(first).tabs[0]!.owner).toBe("agent");
    expect(
      (await f.tool({ action: "snapshot", tabId })).isError,
    ).toBeUndefined();
    await one.detach();
  } finally {
    await f.close();
  }
}, 30000);

it("retries failed launches, rejects invalid input and URLs, and never launches after shutdown", async () => {
  const launch = vi.fn().mockRejectedValue(new Error("private runtime path"));
  const browsers = makeBrowserService("/tmp/codex/unused-browser-root", launch);
  const signal = new AbortController().signal;
  expect(
    (await browsers.tool("agent", { action: "list" }, signal)).isError,
  ).toBe(true);
  expect(
    (await browsers.tool("agent", { action: "list" }, signal)).isError,
  ).toBe(true);
  expect(launch).toHaveBeenCalledTimes(2);
  expect(
    JSON.stringify(await browsers.tool("agent", { action: "list" }, signal)),
  ).not.toContain("private runtime path");
  expect(
    (await browsers.tool("agent", { action: "click", x: Infinity }, signal))
      .isError,
  ).toBe(true);

  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://user:password@example.test",
  ])
    expect(() => browserUrl(url)).toThrow();

  await browsers.close();
  const calls = launch.mock.calls.length;
  expect(
    (await browsers.tool("agent", { action: "list" }, signal)).isError,
  ).toBe(true);
  expect(launch).toHaveBeenCalledTimes(calls);
});

it.runIf(process.env.PAWS_TEST_BROWSER_CONTAINER === "1")(
  "runs Chromium inside the sandbox and keeps host paths outside it",
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { environmentName } = await import("@paws/runtime");
    const exec = promisify(execFile);
    await mkdir("/tmp/codex", { recursive: true });
    const root = await mkdtemp("/tmp/codex/paws-browser-container-");
    const agents = makeAgentService(root);
    const agent = await Effect.runPromise(
      agents.create({ name: "Sandbox", sandbox: true }),
    );
    const name = environmentName(root, agent.id, "agent");
    let runtime: Awaited<ReturnType<typeof launchAgentBrowser>> | undefined;

    try {
      runtime = await launchAgentBrowser(root, agent.id);
      const page =
        runtime.context.pages()[0] ?? (await runtime.context.newPage());
      await page.goto("data:text/html,<title>Isolated browser</title><input>");
      await page.locator("input").fill("sandbox input");
      expect(await page.locator("input").inputValue()).toBe("sandbox input");
      const processes = await exec("docker", [
        "exec",
        name,
        "ps",
        "-eo",
        "args",
      ]);
      expect(processes.stdout).toContain("/usr/lib/chromium/chromium");
      expect(processes.stdout).toContain("--user-data-dir=/agent/browser");
      const mounts = await exec("docker", [
        "inspect",
        "--format",
        "{{json .Mounts}}",
        name,
      ]);
      expect(mounts.stdout).not.toContain("provider-sessions");
      expect(mounts.stdout).not.toContain("/.codex");
      await runtime.close();
      runtime = undefined;
      const remaining = await exec("docker", [
        "exec",
        name,
        "ps",
        "-eo",
        "args",
      ]);
      expect(remaining.stdout).not.toContain("/usr/lib/chromium/chromium");
    } finally {
      await runtime?.close();
      agents.close();
      await exec("docker", ["rm", "--force", name]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
  180000,
);

it("adopts new tabs and popups once and makes page dialogs answerable", async () => {
  const f = await fixture();
  const events: BrowserServerMessage[] = [];

  try {
    const viewer = await f.browsers.attach(
      f.agent.id,
      (event) => events.push(event),
      () => {},
    );
    const opened = await f.tool({ action: "open", url: f.url });
    const content = opened.content[0];

    if (content?.type !== "text") throw new Error("Expected open result.");

    const tabId = String(JSON.parse(content.text).tabId);
    expect(latestState(events).tabs).toHaveLength(2);
    await f.tool({
      action: "click",
      tabId,
      selector: 'role=button[name="Popup"]',
    });
    await vi.waitFor(() => expect(latestState(events).tabs).toHaveLength(3));
    const confirming = f.tool({
      action: "click",
      tabId,
      selector: 'role=button[name="Confirm"]',
    });
    await vi.waitFor(() =>
      expect(
        latestState(events).tabs.find((tab) => tab.id === tabId)?.dialog,
      ).toEqual({ type: "confirm", message: "Continue?" }),
    );
    expect(
      (await f.tool({ action: "dialog", tabId, accept: true })).isError,
    ).toBeUndefined();
    expect((await confirming).isError).toBeUndefined();
    expect(
      latestState(events).tabs.find((tab) => tab.id === tabId)?.dialog,
    ).toBeNull();
    await viewer.input({ type: "watch", tabId });
    await viewer.input({ type: "takeControl", tabId });
    const generation = latestState(events).tabs.find(
      (tab) => tab.id === tabId,
    )!.generation;
    await viewer.input({
      type: "action",
      generation,
      input: { action: "click", tabId, selector: 'role=button[name="Popup"]' },
    });
    await vi.waitFor(() => expect(latestState(events).tabs).toHaveLength(4));
    expect(latestState(events).tabs.at(-1)?.owner).toBe("human");
    await viewer.detach();
  } finally {
    await f.close();
  }
}, 30000);

it("opens Google by default and fits the viewport of the controlling viewer", async () => {
  const f = await fixture();
  const first: BrowserServerMessage[] = [];
  const second: BrowserServerMessage[] = [];

  try {
    const one = await f.browsers.attach(
      f.agent.id,
      (event) => first.push(event),
      () => {},
    );
    await f.tool({ action: "list" });
    const runtime = await f.launch.mock.results[0]!.value;
    const page = runtime.context.pages()[0]!;
    expect(page.url()).toBe("https://www.google.com/");
    const tabId = latestState(first).tabs[0]!.id;
    await one.input({ type: "takeControl", tabId });
    const generation = latestState(first).tabs[0]!.generation;
    await one.input({
      type: "resize",
      tabId,
      generation,
      width: 900,
      height: 1400,
    });
    expect(page.viewportSize()).toEqual({ width: 900, height: 1400 });
    expect(latestState(first)).toMatchObject({ width: 900, height: 1400 });
    const two = await f.browsers.attach(
      f.agent.id,
      (event) => second.push(event),
      () => {},
    );
    await two.input({
      type: "resize",
      tabId,
      generation,
      width: 600,
      height: 1000,
    });
    expect(page.viewportSize()).toEqual({ width: 900, height: 1400 });
    await two.input({ type: "takeControl", tabId });
    expect(page.viewportSize()).toEqual({ width: 600, height: 1000 });
    await one.input({
      type: "resize",
      tabId,
      generation,
      width: 800,
      height: 1200,
    });
    expect(page.viewportSize()).toEqual({ width: 600, height: 1000 });
    await two.detach();
    expect(page.viewportSize()).toEqual({ width: 900, height: 1400 });
    await one.input({
      type: "action",
      generation: latestState(first).tabs[0]!.generation,
      input: { action: "open" },
    });
    expect(runtime.context.pages().at(-1)!.url()).toBe(
      "https://www.google.com/",
    );
    expect(runtime.context.pages().at(-1)!.viewportSize()).toEqual({
      width: 900,
      height: 1400,
    });
    await one.detach();
  } finally {
    await f.close();
  }
}, 30000);

it("preserves agent navigation and form input when the first viewer attaches", async () => {
  const f = await fixture();

  try {
    await f.tool({ action: "list" });
    const runtime = await f.launch.mock.results[0]!.value;
    const page = runtime.context.pages()[0]!;
    const listed = await f.tool({ action: "list" });
    const content = listed.content[0];

    if (content?.type !== "text") throw new Error("Expected browser state.");

    const tabId = JSON.parse(content.text).tabs[0].id;
    await f.tool({ action: "navigate", tabId, url: f.url });
    await f.tool({ action: "fill", tabId, selector: "#name", text: "Draft" });
    const viewer = await f.browsers.attach(
      f.agent.id,
      () => {},
      () => {},
    );
    await f.tool({ action: "list" });
    expect(page.url()).toBe(`${f.url}/`);
    expect(await page.locator("#name").inputValue()).toBe("Draft");
    await viewer.detach();
  } finally {
    await f.close();
  }
}, 30000);

it("answers human-click dialogs without waiting behind the blocked input", async () => {
  const f = await fixture();
  const events: BrowserServerMessage[] = [];

  try {
    const viewer = await f.browsers.attach(
      f.agent.id,
      (event) => events.push(event),
      () => {},
    );
    const tabId = latestState(events).tabs[0]!.id;
    await f.tool({ action: "navigate", tabId, url: f.url });
    await viewer.input({ type: "takeControl", tabId });
    const generation = latestState(events).tabs[0]!.generation;
    const runtime = await f.launch.mock.results[0]!.value;
    const page = runtime.context.pages()[0]!;
    const button = await page
      .getByRole("button", { name: "Confirm" })
      .boundingBox();

    if (!button) throw new Error("Missing confirm button.");

    await viewer.input({
      type: "pointer",
      tabId,
      generation,
      phase: "down",
      button: "left",
      x: button.x + 5,
      y: button.y + 5,
    });
    const clicked = viewer.input({
      type: "pointer",
      tabId,
      generation,
      phase: "up",
      button: "left",
      x: button.x + 5,
      y: button.y + 5,
    });
    await vi.waitFor(() =>
      expect(latestState(events).tabs[0]!.dialog).not.toBeNull(),
    );
    await expect(
      viewer.input({
        type: "action",
        generation: generation - 1,
        input: { action: "dialog", tabId, accept: true },
      }),
    ).rejects.toThrow("Control changed");
    expect(
      (await f.tool({ action: "dialog", tabId, accept: true })).isError,
    ).toBe(true);
    const answered = viewer.input({
      type: "action",
      generation,
      input: { action: "dialog", tabId, accept: true },
    });
    let completed = false;
    void Promise.all([clicked, answered]).then(
      () => {
        completed = true;
      },
      () => {},
    );
    await vi.waitFor(() => expect(completed).toBe(true));
    expect(latestState(events).tabs[0]!.dialog).toBeNull();
    await viewer.detach();
  } finally {
    await f.close();
  }
}, 30000);

it("types Unicode characters from a controlling viewer without invalid key errors", async () => {
  const f = await fixture();
  const events: BrowserServerMessage[] = [];

  try {
    const viewer = await f.browsers.attach(
      f.agent.id,
      (event) => events.push(event),
      () => {},
    );
    const tabId = latestState(events).tabs[0]!.id;
    await f.tool({ action: "navigate", tabId, url: f.url });
    const runtime = await f.launch.mock.results[0]!.value;
    const page = runtime.context.pages()[0]!;
    await page.locator("#name").focus();
    await viewer.input({ type: "takeControl", tabId });
    const generation = latestState(events).tabs[0]!.generation;

    for (const key of ["é", "й", "あ", "😀"]) {
      await viewer.input({
        type: "key",
        tabId,
        generation,
        key,
        phase: "down",
      });
      await viewer.input({ type: "key", tabId, generation, key, phase: "up" });
    }

    expect(await page.locator("#name").inputValue()).toBe("éйあ😀");
    await viewer.detach();
  } finally {
    await f.close();
  }
}, 30000);

it("returns page dialogs to sequential agent key actions before they are answered", async () => {
  const f = await fixture();
  const events: BrowserServerMessage[] = [];

  try {
    const viewer = await f.browsers.attach(
      f.agent.id,
      (event) => events.push(event),
      () => {},
    );
    const tabId = latestState(events).tabs[0]!.id;
    await f.tool({ action: "navigate", tabId, url: f.url });
    const runtime = await f.launch.mock.results[0]!.value;
    await runtime.context
      .pages()[0]!
      .getByRole("button", { name: "Confirm" })
      .focus();
    let result: Awaited<ReturnType<typeof f.tool>> | undefined;
    const pressed = f
      .tool({ action: "press", tabId, key: "Enter" })
      .then((value) => {
        result = value;
      });
    await vi.waitFor(() => expect(result).toBeDefined());
    expect(JSON.stringify(result)).toContain("Continue?");
    expect(
      (await f.tool({ action: "dialog", tabId, accept: true })).isError,
    ).toBeUndefined();
    await pressed;
    await viewer.detach();
  } finally {
    await f.close();
  }
}, 30000);
