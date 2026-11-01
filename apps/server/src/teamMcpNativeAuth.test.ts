import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import * as Fs from "node:fs/promises";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import { makeAgentService } from "./AgentService.ts";
import { teamTool } from "./teamIntegrations.ts";
import {
  closeNativeMcpLogins,
  nativeMcpAuthHttp,
} from "./teamMcpNativeAuth.ts";
import type { TeamMcpHarness } from "./teamMcpHarness.ts";

function browser(url: string, body?: string, cookie?: string) {
  return new Promise<{ status: number; text: string; cookie: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        url,
        {
          method: body ? "POST" : "GET",
          headers: {
            Host: "127.0.0.1:5173",
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              text,
              cookie: response.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(body);
    },
  );
}

it("uses the selected harness, keeps browser approval private, and reuses team access", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-native-browser-");
  const agents = makeAgentService(root);
  let approved = false;
  let starts = 0;
  const integration = {
    id: "design",
    kind: "mcp-http" as const,
    url: "https://service.test/mcp",
  };
  const harness: TeamMcpHarness = {
    providerId: "chosen-codex",
    client: () => ({
      request: async () =>
        approved
          ? { tools: [{ name: "identity" }] }
          : { status: "authentication_required" },
      authenticate: async (onUrl, callback) => {
        starts++;
        onUrl(
          "https://service.test/authorize?state=private-state&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback",
        );
        expect(await callback).toBe(
          "http://127.0.0.1/callback?state=private-state&code=approved",
        );
        approved = true;
      },
    }),
  };
  const server = createServer(async (request, response) => {
    const handled = await nativeMcpAuthHttp(
      request,
      response,
      root,
      async () => integration,
      (id) => {
        expect(id).toBe("chosen-codex");

        return harness;
      },
    );

    if (!handled) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("No listener");

  try {
    const team = await Effect.runPromise(
      agents.saveTeam({
        name: "Project",
        memory: "",
        integrations: [integration],
      }),
    );

    if (!team) throw new Error("No team");

    const first = await Effect.runPromise(
      agents.create({ name: "Ada", teamIds: [team.id] }),
    );
    const second = await Effect.runPromise(
      agents.create({ name: "Grace", teamIds: [team.id] }),
    );
    const outsider = await Effect.runPromise(
      agents.create({ name: "Outsider" }),
    );
    const query = {
      teamId: team.id,
      integrationId: integration.id,
      action: "tools",
    };
    const run = (id: string) =>
      teamTool(root, id, query, AbortSignal.timeout(5000), undefined, harness);
    const result = await run(first.id);
    expect(result).toMatchObject({ status: "authentication_required" });
    const path = `/api/teams/${team.id}/integrations/design/authorize`;
    const url = `http://127.0.0.1:${address.port}${path}`;
    const page = await browser(url);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Open authorization");
    expect(page.text).not.toContain("code=approved");
    const duplicate = await browser(url);
    expect(duplicate.cookie).toBe(page.cookie);
    expect(starts).toBe(1);
    const session = page.cookie.split("=")[1]!;
    const form = new URLSearchParams({
      session,
      callback: "http://127.0.0.1/callback?state=private-state&code=approved",
    }).toString();
    expect((await browser(url, form)).status).toBe(400);
    expect(approved).toBe(false);
    const response = await browser(url, form, page.cookie);
    expect(response.status, response.text).toBe(200);
    expect(approved).toBe(true);
    expect((await browser(url, form, page.cookie)).status).toBe(400);
    expect(await run(second.id)).toMatchObject({
      tools: [{ name: "identity" }],
    });
    await expect(run(outsider.id)).rejects.toThrow("Join this team");
  } finally {
    await closeNativeMcpLogins(root);
    server.closeAllConnections();
    server.close();
    agents.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("cancels native login while the harness is still preparing", async () => {
  const { rememberMcpHarness } = await import("./teamMcpHarness.ts");
  const root = await Fs.mkdtemp("/tmp/codex/paws-native-cancel-");
  const started = Promise.withResolvers<void>();
  let cancelled = false;
  const teamId = "11111111-1111-4111-8111-111111111111";
  const integration = {
    id: "design",
    kind: "mcp-http" as const,
    url: "https://service.test/mcp",
  };
  const harness: TeamMcpHarness = {
    providerId: "codex",
    client: () => ({
      request: async () => ({}),
      authenticate: async (_onUrl, _callback, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
          started.resolve();
        }),
    }),
  };
  await rememberMcpHarness(root, teamId, integration, harness);
  const server = createServer(async (request, response) => {
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

  try {
    const page = browser(
      `http://127.0.0.1:${address.port}/api/teams/${teamId}/integrations/design/authorize`,
    );
    await started.promise;
    await closeNativeMcpLogins(root);
    expect(cancelled).toBe(true);
    expect((await page).status).toBe(400);
  } finally {
    server.closeAllConnections();
    server.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
