import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import * as Fs from "node:fs/promises";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import { makeAgentService } from "./AgentService.ts";
import { teamTool } from "./teamIntegrations.ts";

function browserFetch(
  url: string,
  options: { headers: Record<string, string>; redirect?: string },
) {
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      url,
      { headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const headers = new Headers();

          for (const [name, values] of Object.entries(response.headers)) {
            for (const value of Array.isArray(values) ? values : [values]) {
              if (value !== undefined) headers.append(name, value);
            }
          }

          resolve(
            new Response(Buffer.concat(chunks).toString(), {
              status: response.statusCode!,
              headers,
            }),
          );
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

it.each([401, 403, 429, 503])(
  "classifies remote MCP HTTP %i without blaming Docker",
  async (status) => {
    await Fs.mkdir("/tmp/codex", { recursive: true });
    const root = await Fs.mkdtemp("/tmp/codex/paws-mcp-auth-");
    const agents = makeAgentService(root);
    const server = createServer((_request, response) => {
      response.writeHead(status).end("private-remote-error-body");
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
          integrations: [
            {
              id: "design",
              kind: "mcp-http",
              url: `http://127.0.0.1:${address.port}/mcp`,
            },
          ],
        }),
      );

      if (!team) throw new Error("No team");

      const agent = await Effect.runPromise(
        agents.create({ name: "Ada", teamIds: [team.id] }),
      );
      const result = teamTool(
        root,
        agent.id,
        { teamId: team.id, action: "tools", integrationId: "design" },
        new AbortController().signal,
      );

      if (status === 401) {
        expect(await result).toMatchObject({
          status: "authentication_required",
          authorizationUrl: `/api/teams/${team.id}/integrations/design/authorize`,
        });
      } else {
        await expect(result).rejects.toThrow(
          `Remote MCP request failed (HTTP ${status}).`,
        );
        await expect(result).rejects.not.toThrow("Docker");
        await expect(result).rejects.not.toThrow("private-remote-error-body");
      }
    } finally {
      server.closeAllConnections();
      server.close();
      agents.close();
      await Fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("completes browser OAuth, rejects forged callbacks, and shares refreshed credentials privately", async () => {
  const { createHash } = await import("node:crypto");
  const { join } = await import("node:path");
  const { createServer: createPaws } = await import("./main.ts");
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-mcp-oauth-");
  const app = createPaws(root, {
    discoverProviders: async () => ({
      auth: "authenticated",
      version: "test",
      models: [],
    }),
  });
  let base = "";
  let registration: Record<string, unknown> = {};
  let challenge = "";
  let exchanges = 0;
  let refreshes = 0;
  let acceptedToken = "fixture-access-one";
  let rejectRefresh = false;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const path = new URL(request.url!, base).pathname;
    let body = "";

    for await (const chunk of request) body += chunk;

    if (path === "/.well-known/oauth-protected-resource") {
      response.end(
        JSON.stringify({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ["tools"],
        }),
      );

      return;
    }

    if (path === "/.well-known/oauth-authorization-server") {
      response.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/approve`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        }),
      );

      return;
    }

    if (path === "/register") {
      registration = JSON.parse(body);
      response.writeHead(201).end(
        JSON.stringify({
          ...registration,
          client_id: "fixture-client",
          client_secret: "fixture-client-secret",
          token_endpoint_auth_method: "client_secret_post",
        }),
      );

      return;
    }

    if (path === "/token") {
      const fields = new URLSearchParams(body);
      expect(fields.get("client_secret")).toBe("fixture-client-secret");

      if (fields.get("grant_type") === "authorization_code") {
        exchanges++;
        expect(fields.get("code")).toBe("approved-by-user");
        expect(
          createHash("sha256")
            .update(fields.get("code_verifier")!)
            .digest("base64url"),
        ).toBe(challenge);
      } else {
        refreshes++;
        expect(fields.get("refresh_token")).toBe("fixture-refresh");

        if (rejectRefresh) {
          response
            .writeHead(400)
            .end(JSON.stringify({ error: "invalid_grant" }));

          return;
        }
      }

      response.end(
        JSON.stringify({
          access_token: acceptedToken,
          refresh_token: "fixture-refresh",
          token_type: "Bearer",
        }),
      );

      return;
    }

    if (path !== "/mcp") {
      response.writeHead(404).end();

      return;
    }

    if (request.headers.authorization !== `Bearer ${acceptedToken}`) {
      response
        .writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        })
        .end();

      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405).end();

      return;
    }

    const input = JSON.parse(body);

    if (!("id" in input)) {
      response.writeHead(202).end();

      return;
    }

    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: input.id,
        result:
          input.method === "initialize"
            ? {
                protocolVersion: input.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "Fixture", version: "1" },
              }
            : input.method === "tools/list"
              ? { tools: [{ name: "whoami", inputSchema: { type: "object" } }] }
              : {
                  content: [
                    {
                      type: "text",
                      text: `Team user; ${acceptedToken}; fixture-refresh`,
                    },
                  ],
                },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  app.server.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(app.server, "listening")]);
  const address = server.address();
  const appAddress = app.server.address();

  if (
    !address ||
    typeof address === "string" ||
    !appAddress ||
    typeof appAddress === "string"
  )
    throw new Error("No listener");

  base = `http://127.0.0.1:${address.port}`;
  const pawsBase = `http://127.0.0.1:${appAddress.port}`;
  const agents = makeAgentService(root);

  try {
    const team = await Effect.runPromise(
      agents.saveTeam({
        name: "Project",
        memory: "",
        integrations: [{ id: "design", kind: "mcp-http", url: `${base}/mcp` }],
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
    const request = {
      teamId: team.id,
      integrationId: "design",
      action: "tools",
    };
    const run = (agentId = first.id) =>
      teamTool(root, agentId, request, AbortSignal.timeout(5000));
    const path = `/api/teams/${team.id}/integrations/design/authorize`;
    const headers = { Host: "127.0.0.1:5173" };
    expect(await run()).toMatchObject({
      status: "authentication_required",
      authorizationUrl: path,
    });
    const blocked = await browserFetch(`${pawsBase}${path}`, {
      headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
      redirect: "manual",
    });
    expect(blocked.status).toBe(403);
    const start = await browserFetch(`${pawsBase}${path}`, {
      headers,
      redirect: "manual",
    });
    expect(start.status, await start.clone().text()).toBe(302);
    const authorization = new URL(start.headers.get("location")!);
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    challenge = authorization.searchParams.get("code_challenge")!;
    expect(challenge).toBeTruthy();
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:5173${path}/callback`,
    );
    const callback = `${pawsBase}${path}/callback?state=${authorization.searchParams.get("state")}&code=approved-by-user&iss=${encodeURIComponent(base)}`;
    const forged = await browserFetch(callback, { headers });
    expect(forged.status).toBe(400);
    expect(exchanges).toBe(0);
    const approved = await browserFetch(callback, {
      headers: { ...headers, Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(await approved.text()).toBe("Connected. You can return to Paws.");
    expect(exchanges).toBe(1);
    const replay = await browserFetch(callback, {
      headers: { ...headers, Cookie: cookie },
    });
    expect(replay.status).toBe(400);
    expect(exchanges).toBe(1);
    expect(await run(second.id)).toMatchObject({ tools: [{ name: "whoami" }] });
    const called = await teamTool(
      root,
      second.id,
      { ...request, action: "call", tool: "whoami" },
      AbortSignal.timeout(5000),
    );
    expect(called).toMatchObject({
      content: [{ text: "Team user; [redacted]; [redacted]" }],
    });
    acceptedToken = "fixture-access-two";
    expect(await run(second.id)).toMatchObject({ tools: [{ name: "whoami" }] });
    expect(refreshes).toBe(1);
    await expect(run(outsider.id)).rejects.toThrow("Join this team");
    const authPath = join(root, "team-auth", team.id, "design", "oauth.json");
    expect((await Fs.stat(authPath)).mode & 0o777).toBe(0o600);
    expect(
      JSON.stringify(await Effect.runPromise(agents.listTeams())),
    ).not.toContain("fixture-access");
    const saved = JSON.parse(await Fs.readFile(authPath, "utf8"));
    expect(saved.tokens.access_token).toBe(acceptedToken);
    expect(saved.tokens.issuer).toBe(base);
    expect(saved.verifier).toBeUndefined();
    acceptedToken = "expired";
    rejectRefresh = true;
    expect(await run()).toMatchObject({ status: "authentication_required" });
    const reconnect = await browserFetch(`${pawsBase}${path}`, {
      headers,
      redirect: "manual",
    });
    expect(reconnect.status).toBe(302);
    const reconnectUrl = new URL(reconnect.headers.get("location")!);
    const reconnectCookie = reconnect.headers.get("set-cookie")!.split(";")[0]!;
    const declined = await browserFetch(
      `${pawsBase}${path}/callback?state=${reconnectUrl.searchParams.get("state")}&error=access_denied`,
      { headers: { ...headers, Cookie: reconnectCookie } },
    );
    expect(declined.status).toBe(400);
    expect(await declined.text()).toContain("declined");
  } finally {
    server.closeAllConnections();
    server.close();
    agents.close();
    await app.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("expires OAuth approval and binds credentials to the configured server", async () => {
  const { TeamMcpAuth } = await import("./teamMcpAuth.ts");
  const { join } = await import("node:path");
  const root = await Fs.mkdtemp("/tmp/codex/paws-mcp-state-");

  try {
    const provider = new TeamMcpAuth(
      root,
      "https://first.test/mcp",
      "http://localhost:5173/callback",
    );
    const state = provider.state();
    provider.saveCodeVerifier("private-verifier");
    provider.redirectToAuthorization(new URL("https://first.test/authorize"));
    provider.saveTokens({
      access_token: "private-access",
      token_type: "Bearer",
    });
    expect(() => provider.consume("wrong-state", state, null)).toThrow(
      "expired or invalid",
    );
    expect(
      new TeamMcpAuth(root, "https://second.test/mcp").tokens(),
    ).toBeUndefined();
    const path = join(root, "oauth.json");
    const saved = JSON.parse(await Fs.readFile(path, "utf8"));
    await Fs.writeFile(
      path,
      JSON.stringify({ ...saved, expiresAt: Date.now() - 1 }),
    );
    const reopened = new TeamMcpAuth(root, "https://first.test/mcp");
    expect(reopened.pending()).toBeUndefined();
    expect(() => reopened.consume(state, state, null)).toThrow(
      "expired or invalid",
    );
    expect(reopened.tokens()?.access_token).toBe("private-access");
  } finally {
    await Fs.rm(root, { recursive: true, force: true });
  }
});
