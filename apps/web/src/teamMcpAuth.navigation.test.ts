import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import * as Fs from "node:fs/promises";
import { chromium } from "playwright";
import { expect, it } from "vite-plus/test";
import {
  rememberedMcpHarness,
  rememberMcpHarness,
  type TeamMcpHarness,
} from "../../server/src/teamMcpHarness.ts";
import {
  nativeMcpAuthHttp,
  closeNativeMcpLogins,
} from "../../server/src/teamMcpNativeAuth.ts";

it("submits the private login form with a same-origin header in Chromium", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-form-navigation-");
  const teamId = "11111111-1111-4111-8111-111111111111";
  const integration = {
    id: "fixture",
    kind: "mcp-http" as const,
    url: "https://service.test/mcp",
  };
  let submittedOrigin: string | undefined;
  let approved = false;
  const harness: TeamMcpHarness = {
    providerId: "fixture-harness",
    client: () => ({
      request: async () => ({}),
      authenticate: async (onUrl, callback, signal) => {
        onUrl(
          "https://service.test/authorize?state=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback",
        );
        await Promise.race([
          callback,
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              { once: true },
            );
          }),
        ]);
        approved = true;
      },
    }),
  };
  await rememberMcpHarness(root, teamId, integration, harness);
  expect(await rememberedMcpHarness(root, teamId, integration)).toBe(
    harness.providerId,
  );
  const server = createServer(async (request, response) => {
    if (request.method === "POST") submittedOrigin = request.headers.origin;

    await nativeMcpAuthHttp(
      request,
      response,
      root,
      async () => integration,
      () => harness,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("No listener");

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    // Intercept every browser request: the virtual allowed origin never reaches
    // a live app, and the fixture receives the browser's actual Origin header.
    await page.route("**/*", async (route) => {
      const input = route.request();
      const result = await new Promise<{
        status: number;
        headers: Record<string, string>;
        body: Buffer;
      }>((resolve, reject) => {
        const request = httpRequest(
          `http://127.0.0.1:${address.port}${new URL(input.url()).pathname}`,
          {
            method: input.method(),
            headers: { ...input.headers(), host: "localhost:5173" },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                headers: Object.fromEntries(
                  Object.entries(response.headers)
                    .filter(([, value]) => value !== undefined)
                    .map(([key, value]) => [
                      key,
                      Array.isArray(value) ? value.join("\n") : String(value),
                    ]),
                ),
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(input.postDataBuffer());
      });
      await route.fulfill(result);
    });
    await page.goto(
      `http://localhost:5173/api/teams/${teamId}/integrations/fixture/authorize`,
    );
    await page
      .getByLabel("Callback URL")
      .fill("http://127.0.0.1/callback?state=fixture&code=approved");
    const [response] = await Promise.all([
      page.waitForNavigation(),
      page.getByRole("button", { name: "Connect" }).click(),
    ]);
    expect(submittedOrigin).toBe("http://localhost:5173");
    expect(response?.status()).toBe(200);
    expect(approved).toBe(true);
    expect(await page.locator("body").textContent()).toContain("Connected.");
  } finally {
    await browser.close();
    await closeNativeMcpLogins(root);
    server.closeAllConnections();
    server.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
