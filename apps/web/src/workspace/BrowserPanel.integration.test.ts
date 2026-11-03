import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite-plus";
import { expect, it } from "vite-plus/test";
import { createServer } from "../../../server/src/main.ts";
import { launchBrowserFixture } from "../../../server/src/browserTestRuntime.ts";

it("opens a real browser tab from the workspace plus button through the dev proxy", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-browser-ui-");
  let runtime: Awaited<ReturnType<typeof launchBrowserFixture>> | undefined;
  const app = createServer(root, {
    runChat: async () => {},
    launchBrowser: async (...args) => {
      runtime = await launchBrowserFixture(...args);

      return runtime;
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string") throw new Error("No API port.");

  const api = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${api}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Browser fixture" }),
  });
  const agent = await response.json();
  const vite = await createViteServer({
    root: resolve("apps/web"),
    configFile: resolve("apps/web/vite.config.ts"),
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {
        "/api": {
          target: api,
          ws: true,
          headers: { origin: "http://localhost:5173" },
        },
        "/ws": {
          target: api,
          ws: true,
          headers: { origin: "http://localhost:5173" },
        },
      },
    },
  });
  const viewer = await chromium.launch({ headless: true });

  try {
    await vite.listen();
    const port = vite.httpServer?.address();

    if (!port || typeof port === "string") throw new Error("No frontend port.");

    const updates: unknown[] = [];
    const page = await viewer.newPage({
      viewport: { width: 1440, height: 900 },
    });
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        try {
          const message = JSON.parse(String(payload));

          if (message.type === "resize") updates.push(message);
        } catch {
          /* Other dev-server messages are not browser protocol. */
        }
      });
      socket.on("framereceived", ({ payload }) => {
        try {
          const message = JSON.parse(String(payload));

          if (message.type === "state")
            updates.push({
              width: message.width,
              height: message.height,
              selectedTabId: message.selectedTabId,
            });
        } catch {
          /* Other dev-server messages are not browser protocol. */
        }
      });
    });
    page.setDefaultTimeout(4000);
    await page.goto(`http://127.0.0.1:${port.port}/#agent-${agent.id}`);
    await page
      .getByRole("button", { name: "Toggle right panel", exact: true })
      .click();
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    const plus = page.getByRole("button", { name: "New browser tab" });
    await plus.click();
    await page
      .getByRole("button", { name: "Return control", exact: true })
      .waitFor();
    expect(await page.locator(".browser-tab").count()).toBeGreaterThan(0);
    expect(
      await page.getByRole("textbox", { name: "Browser address" }).isEnabled(),
    ).toBe(true);
    await page.waitForFunction(() =>
      (
        document.querySelector<HTMLInputElement>(
          '[aria-label="Browser address"]',
        )?.value ?? ""
      ).startsWith("https://www.google.com/"),
    );
    await page
      .getByRole("button", { name: "Maximize panel", exact: true })
      .click();
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page
      .waitForFunction(() => {
        const stage = document.querySelector<HTMLElement>(".browser-stage");
        const image = stage?.querySelector("img");

        return (
          stage &&
          image &&
          image.naturalWidth === stage.clientWidth &&
          image.naturalHeight === stage.clientHeight
        );
      })
      .catch(async (error) => {
        const dimensions = await page
          .locator(".browser-stage")
          .evaluate((node) => {
            const image = node.querySelector("img");

            return {
              stage: [node.clientWidth, node.clientHeight],
              image: [image?.naturalWidth, image?.naturalHeight],
            };
          });

        throw new Error(
          `Viewport did not fit: ${JSON.stringify({ dimensions, updates: updates.slice(-8) })}`,
          { cause: error },
        );
      });
    const size = await page.locator(".browser-stage").evaluate((node) => ({
      width: node.clientWidth,
      height: node.clientHeight,
    }));
    expect(size.height).toBeGreaterThan(800);
    expect(size.width).toBeGreaterThan(1000);
    await page
      .getByRole("button", { name: "Restore panel size", exact: true })
      .click();
    await page.waitForFunction(() => {
      const stage = document.querySelector<HTMLElement>(".browser-stage");
      const image = stage?.querySelector("img");

      return (
        stage &&
        image &&
        image.naturalWidth === stage.clientWidth &&
        image.naturalHeight === stage.clientHeight
      );
    });
    expect(await page.getByRole("alert").count()).toBe(0);
    const remote = runtime!.context
      .pages()
      .findLast((tab) => tab.url().startsWith("https://www.google.com/"))!;
    await remote.setContent(
      '<button style="position:fixed;inset:0" ondblclick="this.textContent=\'Double clicked\'">Click</button>',
    );
    await page
      .getByRole("img", { name: "Browser page interaction" })
      .dblclick();
    await expect
      .poll(() => remote.locator("button").textContent())
      .toBe("Double clicked");
  } finally {
    await viewer.close();
    await vite.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
