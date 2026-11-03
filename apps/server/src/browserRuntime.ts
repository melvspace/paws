import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import { leaseToolRuntime, resolveWorkspaceDirectory } from "@paws/runtime";
import { ChatToolError } from "@paws/provider-core";
import { agentContext } from "./teamContext.ts";

const preparationTimeoutMs = 5 * 60_000;
const preparations = new Map<string, Promise<string>>();
// Use Chromium's native implementation rather than patching page globals. This
// applies to every tab, popup and frame, including pages created by the site.
const browserArgs = ["--disable-blink-features=AutomationControlled"];
const executeFile = promisify(execFile);

export function chromiumUserAgent(
  version: string,
  platform: NodeJS.Platform = process.platform,
) {
  const major = /\b(\d+)\.\d+\.\d+\.\d+\b/.exec(version)?.[1];

  if (!major) throw new Error("Cannot determine Chromium version.");

  const system =
    platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64";

  // Match Chromium's reduced desktop UA, keeping its real major version.
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// CDP stays on pipes inside the agent's container. The host-side, single-client
// bridge is loopback-only and has an unguessable URL; no debug port is exposed.
const containerBridge = `
const { spawn } = require('node:child_process');
const browser = spawn('/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  ...${JSON.stringify(browserArgs)},
  '--user-agent=' + process.argv[2],
  '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + process.argv[1], 'about:blank'
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
process.stdin.on('data', data => browser.stdio[3].write(data));
browser.stdio[4].pipe(process.stdout);
process.stdin.on('end', () => browser.kill());
browser.on('error', () => process.exit(1));
browser.on('exit', () => process.exit());
`;

export async function launchAgentBrowser(root: string, agentId: string) {
  const lease = await leaseToolRuntime(
    root,
    agentId,
    agentContext(root, agentId),
  );
  let dispose = async () => {};
  let preparing = Boolean(lease.container);
  const preparationSignal = AbortSignal.timeout(preparationTimeoutMs);

  try {
    if (!lease.container) {
      const { stdout } = await executeFile(
        chromium.executablePath(),
        ["--version"],
        { timeout: 15000 },
      );
      const context = await chromium.launchPersistentContext(
        resolveWorkspaceDirectory(root, agentId, "browser"),
        {
          headless: true,
          // The default headless shell lacks normal Chromium capabilities.
          channel: "chromium",
          args: browserArgs,
          ignoreDefaultArgs: ["--enable-automation"],
          userAgent: chromiumUserAgent(stdout),
          viewport: { width: 1280, height: 800 },
          acceptDownloads: false,
        },
      );
      dispose = () => context.close();

      return {
        context,
        async close() {
          await dispose();
          await lease.dispose();
        },
      };
    }

    let preparation = preparations.get(lease.container);

    if (!preparation) {
      preparation = lease.execute(
        "command -v chromium >/dev/null || (sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium)",
        preparationSignal,
        { timeoutMs: preparationTimeoutMs },
      );
      preparations.set(lease.container, preparation);
    }

    try {
      await preparation;
    } finally {
      if (preparations.get(lease.container) === preparation)
        preparations.delete(lease.container);
    }

    preparing = false;
    const userAgent = chromiumUserAgent(
      await lease.execute("/usr/bin/chromium --version", preparationSignal),
      "linux",
    );
    const bridge = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: `/${randomUUID()}`,
      maxPayload: 8 * 1024 * 1024,
    });
    dispose = async () => {
      for (const socket of bridge.clients) socket.terminate();

      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    };
    await once(bridge, "listening");
    const address = bridge.address();

    if (!address || typeof address === "string")
      throw new Error("Browser bridge unavailable.");

    const launch = lease.launch("node", [
      "-e",
      containerBridge,
      lease.browserProfile,
      userAgent,
    ]);
    const child = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const closeBridge = dispose;
    dispose = async () => {
      child.stdin.end();
      child.kill();
      await lease.dispose();
      await closeBridge();
    };
    bridge.once("connection", (socket) => {
      // Only this Playwright connection can attach to the pipe.
      bridge.removeAllListeners("connection");
      let pending = Buffer.alloc(0);
      child.stdout.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);

        if (pending.length > 16 * 1024 * 1024) {
          socket.terminate();
          child.kill();

          return;
        }

        let boundary = pending.indexOf(0);

        while (boundary !== -1) {
          if (socket.readyState === 1)
            socket.send(pending.subarray(0, boundary).toString());

          pending = pending.subarray(boundary + 1);
          boundary = pending.indexOf(0);
        }
      });
      socket.on("message", (data) => child.stdin.write(`${data.toString()}\0`));
      socket.on("close", () => child.stdin.end());
      child.on("error", () => socket.close());
      child.on("exit", () => socket.close());
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    const browser = await chromium.connectOverCDP(
      `ws://127.0.0.1:${address.port}${bridge.options.path}`,
      { timeout: 15000 },
    );
    const context = browser.contexts()[0];

    if (!context) throw new Error("Browser context unavailable.");

    const closeRuntime = dispose;
    dispose = async () => {
      const cdp = await browser.newBrowserCDPSession().catch(() => null);
      await cdp?.send("Browser.close").catch(() => {});
      await browser.close().catch(() => {});
      await closeRuntime();
    };

    return { context, close: dispose };
  } catch {
    await dispose().catch(() => {});
    await lease.dispose();

    throw new ChatToolError(
      lease.container
        ? preparing
          ? preparationSignal.aborted
            ? "Browser setup timed out. Reconnect to retry."
            : "Browser setup failed. Reconnect to retry."
          : "Browser could not start. Reconnect to retry."
        : "Browser unavailable. Run pnpm --filter @paws/server exec playwright install chromium on the host, then retry.",
    );
  }
}
