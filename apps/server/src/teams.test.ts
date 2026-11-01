import { once } from "node:events";
import * as Fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import { makeAgentService } from "./AgentService.ts";
import { agentContext, withMemoryContext, memoryTool } from "./teamContext.ts";
import { listAgentSkills } from "./agentSkills.ts";
import { teamTool } from "./teamIntegrations.ts";
import { workspaceLayout, containerArgs } from "@paws/runtime";

it("persists multiple memberships and private memories, rejects unknown teams, and detaches deleted teams", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-teams-");
  let service = makeAgentService(root);

  try {
    const first = await Effect.runPromise(
      service.saveTeam({ name: "Project A", memory: "Shared project facts" }),
    );
    const second = await Effect.runPromise(
      service.saveTeam({ name: "Project B", memory: "Other project" }),
    );

    if (!first || !second) throw new Error("Expected teams.");

    const agent = await Effect.runPromise(
      service.create({
        name: "Ada",
        memory: "Personal preference",
        teamIds: [first.id, second.id],
      }),
    );
    const outsider = await Effect.runPromise(
      service.create({ name: "Grace", memory: "Private to Grace" }),
    );
    await expect(
      Effect.runPromise(
        service.update(agent.id, { name: "Ada", teamIds: ["missing"] }),
      ),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        service.update(agent.id, { name: "Ada", memory: "x".repeat(16001) }),
      ),
    ).rejects.toThrow();
    service.close();
    service = makeAgentService(root);
    expect(agentContext(root, agent.id)).toMatchObject({
      memory: "Personal preference",
      teams: [first, second],
    });
    expect(withMemoryContext(root, outsider.id, "Hello")).not.toContain(
      "Shared project facts",
    );
    expect(withMemoryContext(root, agent.id, "Hello")).not.toContain(
      "Private to Grace",
    );
    memoryTool(root, agent.id, { memory: "Remembered by Ada" });
    memoryTool(root, agent.id, {
      teamId: first.id,
      memory: "Remembered by the team",
    });
    expect(memoryTool(root, agent.id, {})).toEqual({
      memory: "Remembered by Ada",
    });
    expect(() => memoryTool(root, outsider.id, { teamId: first.id })).toThrow(
      "Join this team",
    );
    expect(withMemoryContext(root, agent.id, "Hello")).toContain(
      "Remembered by the team",
    );

    await Fs.writeFile(
      join(root, "teams", first.id, "files", "keep.txt"),
      "Shared file",
    );
    await Effect.runPromise(service.removeTeam(first.id));
    expect(agentContext(root, agent.id).teams.map((team) => team.id)).toEqual([
      second.id,
    ]);
    expect((await Effect.runPromise(service.list()))[0]?.teamIds).toEqual([
      second.id,
    ]);
    expect(
      await Fs.readFile(
        join(root, "teams", first.id, "files", "keep.txt"),
        "utf8",
      ),
    ).toBe("Shared file");
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("discovers team skills only for members with personal skills taking precedence and mounts only selected teams", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-team-skills-");
  const service = makeAgentService(root);

  try {
    const team = await Effect.runPromise(
      service.saveTeam({ name: "Project", memory: "" }),
    );

    if (!team) throw new Error("Expected team.");

    const agent = await Effect.runPromise(
      service.create({ name: "Ada", teamIds: [team.id] }),
    );
    const layout = workspaceLayout(root, agent.id);
    const teamSkills = join(root, "teams", team.id, "skills");

    for (const [directory, description] of [
      [join(teamSkills, "writer"), "Shared"],
      [join(teamSkills, "review"), "Review"],
      [join(layout.skills, "writer"), "Personal"],
    ]) {
      await Fs.mkdir(directory!, { recursive: true });
      await Fs.writeFile(
        join(directory!, "SKILL.md"),
        `---\nname: ${directory!.split("/").at(-1)}\ndescription: ${description}\n---\nInstructions`,
      );
    }

    expect(listAgentSkills(root, agent.id).map((skill) => skill.name)).toEqual([
      "writer",
    ]);
    expect(listAgentSkills(root, agent.id, [team.id])).toEqual([
      {
        name: "review",
        description: "Review",
        path: `/teams/${team.id}/skills/review/SKILL.md`,
      },
      {
        name: "writer",
        description: "Personal",
        path: "/home/agent/.agents/skills/writer/SKILL.md",
      },
    ]);
    const args = containerArgs({
      name: "test",
      root,
      workspace: layout.workspace,
      home: layout.home,
      teamIds: [team.id],
      uid: 1000,
      gid: 1000,
    });
    expect(args).toContain(
      `type=bind,src=${teamSkills},dst=/teams/${team.id}/skills,readonly`,
    );
    expect(args).toContain(
      `type=bind,src=${join(root, "teams", team.id, "files")},dst=/teams/${team.id}/files`,
    );
    expect(args.join(" ")).not.toContain("team-auth");
    await expect(
      teamTool(
        root,
        agent.id,
        { teamId: "11111111-1111-4111-8111-111111111111", action: "list" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Join this team");
    await Effect.runPromise(
      service.update(agent.id, { name: "Ada", teamIds: [] }),
    );
    await expect(
      teamTool(
        root,
        agent.id,
        { teamId: team.id, action: "list" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Join this team");
    await expect(
      teamTool(
        root,
        agent.id,
        { teamId: team.id, action: "install", script: "touch /installed" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Join this team");
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("keeps shared authentication outside snapshots and agent mounts, and reuses integration configuration across members", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-team-auth-");
  const service = makeAgentService(root);

  try {
    const team = await Effect.runPromise(
      service.saveTeam({ name: "Project", memory: "" }),
    );

    if (!team) throw new Error("Expected team.");

    const first = await Effect.runPromise(
      service.create({ name: "Ada", teamIds: [team.id] }),
    );
    const second = await Effect.runPromise(
      service.create({ name: "Grace", teamIds: [team.id] }),
    );
    const signal = new AbortController().signal;
    await teamTool(
      root,
      first.id,
      {
        teamId: team.id,
        action: "configure",
        integration: {
          id: "pachca",
          kind: "cli",
          command: "node",
          args: ["/workspace/pachca.js"],
        },
        secrets: { PACHCA_TOKEN: "saved" },
      },
      signal,
      (reference) => {
        expect(reference).toBe("saved");

        return "test-secret-value";
      },
    );
    expect(
      await teamTool(
        root,
        second.id,
        { teamId: team.id, action: "list" },
        signal,
      ),
    ).toEqual([
      {
        id: "pachca",
        kind: "cli",
        command: "node",
        args: ["/workspace/pachca.js"],
      },
    ]);
    expect(
      JSON.stringify(await Effect.runPromise(service.listTeams())),
    ).not.toContain("test-secret-value");
    const file = join(root, "team-auth", team.id, "pachca", "environment.json");
    expect((await Fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await Fs.readFile(file, "utf8"))).toEqual({
      values: { PACHCA_TOKEN: "test-secret-value" },
      endpoint: null,
    });
    await expect(
      teamTool(
        root,
        first.id,
        {
          teamId: team.id,
          action: "configure",
          integration: { id: "../escape", kind: "cli", command: "node" },
        },
        signal,
      ),
    ).rejects.toThrow();
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("discovers and calls a remote MCP with private team authentication and redacts returned secrets", async () => {
  const { createServer } = await import("node:http");
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-team-mcp-");
  const service = makeAgentService(root);
  const secret = 'private-"quoted"-token';
  let authenticatedCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${secret}`) {
      response.writeHead(401).end();

      return;
    }

    let body = "";

    for await (const chunk of request) body += chunk;

    if (!body) {
      response.writeHead(405).end();

      return;
    }

    const input = JSON.parse(body);

    if (!("id" in input)) {
      response.writeHead(202).end();

      return;
    }

    const result =
      input.method === "initialize"
        ? {
            protocolVersion: input.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "Fixture", version: "1" },
          }
        : input.method === "tools/list"
          ? {
              tools: [
                {
                  name: "identity",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : {
              content: [{ type: "text", text: `identity response ${secret}` }],
            };
    authenticatedCalls++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("Expected listener.");

  try {
    const team = await Effect.runPromise(
      service.saveTeam({ name: "Project", memory: "" }),
    );

    if (!team) throw new Error("Expected team.");

    const agent = await Effect.runPromise(
      service.create({ name: "Ada", teamIds: [team.id] }),
    );
    const signal = new AbortController().signal;
    await teamTool(
      root,
      agent.id,
      {
        teamId: team.id,
        action: "configure",
        integration: {
          id: "youtrack",
          kind: "mcp-http",
          url: `http://127.0.0.1:${address.port}/mcp`,
        },
        secrets: { BEARER_TOKEN: "saved" },
      },
      signal,
      () => secret,
    );
    expect(
      await teamTool(
        root,
        agent.id,
        { teamId: team.id, action: "tools", integrationId: "youtrack" },
        signal,
      ),
    ).toMatchObject({ tools: [{ name: "identity" }] });
    const result = await teamTool(
      root,
      agent.id,
      {
        teamId: team.id,
        action: "call",
        integrationId: "youtrack",
        tool: "identity",
      },
      signal,
    );
    expect(JSON.stringify(result)).not.toContain("quoted");
    expect(result).toMatchObject({
      content: [{ text: "identity response [redacted]" }],
    });
    expect(authenticatedCalls).toBe(4);
  } finally {
    server.closeAllConnections();
    server.close();
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("uses the team's installed image, returns redacted diagnostics and cleans up failed CLI containers", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-cli-errors-");
  const service = makeAgentService(root);
  const originalPath = process.env.PATH;

  try {
    const team = await Effect.runPromise(
      service.saveTeam({ name: "Project", memory: "" }),
    );

    if (!team) throw new Error("Expected team.");

    const agent = await Effect.runPromise(
      service.create({ name: "Installer", teamIds: [team.id] }),
    );
    const signal = new AbortController().signal;
    await teamTool(
      root,
      agent.id,
      {
        teamId: team.id,
        action: "configure",
        integration: {
          id: "custom-cli",
          kind: "cli",
          command: "/workspace/bin/custom-cli",
        },
        secrets: { SERVICE_TOKEN: "saved" },
      },
      signal,
      () => 'private-"token"',
    );
    const image = `sha256:${"a".repeat(64)}`;
    await Fs.mkdir(join(root, "teams", team.id), { recursive: true });
    await Fs.writeFile(
      join(root, "teams", team.id, "environment.json"),
      JSON.stringify({ image }),
    );
    await Fs.writeFile(
      join(root, "docker"),
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify(args) + '\\n');
if (args[0] === 'run') {
  console.log('partial output');
  console.error('command missing; token=' + process.env.SERVICE_TOKEN);
  process.exit(127);
}
`,
      { mode: 0o700 },
    );
    process.env.PATH = root;
    const result = await teamTool(
      root,
      agent.id,
      { teamId: team.id, action: "exec", integrationId: "custom-cli" },
      signal,
    );
    expect(result).toEqual({
      isError: true,
      exitCode: 127,
      stdout: "partial output\n",
      stderr: "command missing; token=[redacted]\n",
    });
    const calls = (await Fs.readFile(join(root, "calls"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const launch = calls[0];
    expect(launch).toContain(image);
    expect(launch).not.toContain("paws-chat-runtime:1");
    expect(calls[1]).toEqual([
      "rm",
      "--force",
      launch[launch.indexOf("--name") + 1],
    ]);
    expect(JSON.stringify(calls)).not.toContain("private-");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;

    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
