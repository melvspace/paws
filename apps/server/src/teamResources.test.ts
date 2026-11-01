import * as Fs from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vite-plus/test";
import { createServer } from "./main.ts";

it("manages shared files and skill packages through HTTP without traversing links or exposing credentials", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-team-http-");
  const app = createServer(root);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string")
    throw new Error("Expected listener.");

  const base = `http://127.0.0.1:${address.port}`;
  const json = { "Content-Type": "application/json" };

  try {
    const response = await fetch(`${base}/api/teams`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: "Project",
        memory: "Shared facts",
        integrations: [{ id: "pachca", kind: "cli", command: "node" }],
      }),
    });
    expect(response.status).toBe(201);
    const team = await response.json();
    const files = `${base}/api/teams/${team.id}/resources/files`;
    expect(
      (
        await fetch(`${files}/${encodeURIComponent("notes/todo.txt")}`, {
          method: "PUT",
          body: "Shared task",
        })
      ).status,
    ).toBe(204);
    expect(await (await fetch(`${files}/notes`)).json()).toEqual([
      { name: "todo.txt", directory: false },
    ]);
    expect(
      await (
        await fetch(`${files}/${encodeURIComponent("notes/todo.txt")}`)
      ).text(),
    ).toBe("Shared task");
    const skill = `${base}/api/teams/${team.id}/resources/skills/${encodeURIComponent("review/SKILL.md")}`;
    expect(
      (
        await fetch(skill, {
          method: "PUT",
          body: "---\nname: review\ndescription: Review\n---\nInstructions",
        })
      ).status,
    ).toBe(204);
    expect(
      (await fetch(skill, { method: "PUT", body: "x".repeat(65537) })).status,
    ).toBe(413);
    await Fs.symlink(
      join(root, "state.sqlite"),
      join(root, "teams", team.id, "files", "linked"),
    );
    expect((await fetch(`${files}/linked`)).status).toBe(400);
    expect(
      (await fetch(`${files}/${encodeURIComponent("../state.sqlite")}`)).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${files}/${encodeURIComponent("../../team-auth/file")}`, {
          method: "PUT",
          body: "escape",
        })
      ).status,
    ).toBe(400);
    const credentials = await fetch(
      `${base}/api/teams/${team.id}/integrations/pachca/credentials`,
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          name: "PACHCA_TOKEN",
          value: "private-fixture",
          expectedIntegration: { id: "pachca", kind: "cli", command: "node" },
        }),
      },
    );
    expect(credentials.status).toBe(204);
    expect(await (await fetch(`${base}/api/agents`)).text()).not.toContain(
      "private-fixture",
    );
    expect(
      (await fetch(`${files}/todo.txt`, { method: "DELETE" })).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${files}/${encodeURIComponent("notes/todo.txt")}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      (await fetch(`${base}/api/teams/${team.id}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect((await fetch(files)).status).toBe(404);
  } finally {
    await app.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("moves idle agents atomically, preserves other teams, and rejects busy or stale moves", async () => {
  const { Effect } = await import("effect");
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-move-http-");
  const app = createServer(root, {
    discoverProviders: async () => ({
      auth: "authenticated",
      version: "test",
      models: [{ id: "test-model", name: "Test", options: [] }],
    }),
    runChat: (turn) =>
      new Promise<void>((resolve) => {
        turn.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string")
    throw new Error("Expected listener.");

  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "Content-Type": "application/json" };
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  try {
    const teams = [];

    for (const name of ["A", "B", "C"]) {
      teams.push(await (await post("/api/teams", { name, memory: "" })).json());
    }

    const agent = await (
      await post("/api/agents", {
        name: "Ada",
        teamIds: [teams[0].id, teams[2].id],
      })
    ).json();
    const move = await post(`/api/agents/${agent.id}/move`, {
      fromTeamId: teams[0].id,
      toTeamId: teams[1].id,
    });
    expect(move.status).toBe(200);
    expect((await move.json()).teamIds).toEqual([teams[2].id, teams[1].id]);
    expect(
      (
        await post(`/api/agents/${agent.id}/move`, {
          fromTeamId: teams[0].id,
          toTeamId: teams[1].id,
        })
      ).status,
    ).toBe(400);
    const provider = await Effect.runPromise(app.providers.create("codex"));
    await app.providers.refresh(provider.config.id);
    await Effect.runPromise(
      app.chat.send(agent.id, {
        requestId: "busy",
        text: "Work",
        selection: {
          providerId: provider.config.id,
          modelId: "test-model",
          options: {},
        },
      }),
    );
    await expect.poll(() => app.chat.get(agent.id).status).toBe("running");
    expect(
      (
        await post(`/api/agents/${agent.id}/move`, {
          fromTeamId: teams[1].id,
          toTeamId: teams[0].id,
        })
      ).status,
    ).toBe(409);
    expect(
      (await (await fetch(`${base}/api/agents`)).json()).agents[0].teamIds,
    ).toEqual([teams[2].id, teams[1].id]);
  } finally {
    await app.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("keeps uploads inside the pinned directory when its parent is replaced mid-body", async () => {
  const { IncomingMessage, ServerResponse } = await import("node:http");
  const { Socket } = await import("node:net");
  const { teamResources } = await import("./teamResources.ts");
  const root = await Fs.mkdtemp("/tmp/codex/paws-upload-race-");
  const directory = join(
    root,
    "teams",
    "00000000-0000-4000-8000-000000000000",
    "files",
    "notes",
  );
  const outside = join(root, "private");
  await Fs.mkdir(directory, { recursive: true });
  await Fs.mkdir(outside);
  await Fs.writeFile(join(outside, "secret"), "unchanged");
  const request = new IncomingMessage(new Socket());
  request.method = "PUT";
  request.url =
    "/api/teams/00000000-0000-4000-8000-000000000000/resources/files/notes/secret";
  Object.defineProperty(request, Symbol.asyncIterator, {
    value: async function* () {
      await Fs.rename(directory, `${directory}-original`);
      await Fs.symlink(outside, directory);
      yield Buffer.from("upload");
    },
  });
  const response = new ServerResponse(request);

  try {
    await teamResources(request, response, root, async () => true);
    expect(response.statusCode).toBe(204);
    expect(await Fs.readFile(join(outside, "secret"), "utf8")).toBe(
      "unchanged",
    );
    expect(
      await Fs.readFile(join(`${directory}-original`, "secret"), "utf8"),
    ).toBe("upload");
  } finally {
    response.destroy();
    request.destroy();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("patches only supplied team fields and rejects stale edits to the same field", async () => {
  const { Effect } = await import("effect");
  const { makeAgentService } = await import("./AgentService.ts");
  const root = await Fs.mkdtemp("/tmp/codex/paws-team-patch-");
  const service = makeAgentService(root);

  try {
    const team = await Effect.runPromise(
      service.saveTeam({ name: "Original", memory: "old" }),
    );
    expect(team).not.toBeNull();
    await Effect.runPromise(
      service.saveTeam(
        {
          memory: "new",
          integrations: [{ id: "tool", kind: "cli", command: "node" }],
        },
        team!.id,
      ),
    );
    const renamed = await Effect.runPromise(
      service.saveTeam(
        { name: "Renamed", expected: { name: "Original" } },
        team!.id,
      ),
    );
    expect(renamed).toMatchObject({
      name: "Renamed",
      memory: "new",
      integrations: [{ id: "tool" }],
    });
    await expect(
      Effect.runPromise(
        service.saveTeam(
          { memory: "stale", expected: { memory: "old" } },
          team!.id,
        ),
      ),
    ).rejects.toThrow();
    expect(await Effect.runPromise(service.listTeams())).toEqual([renamed]);
  } finally {
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("rejects credential saves from an editor with a stale integration endpoint", async () => {
  const root = await Fs.mkdtemp("/tmp/codex/paws-stale-credential-");
  const app = createServer(root);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string") throw new Error("No listener");

  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "Content-Type": "application/json" };
  const original = {
    id: "remote",
    kind: "mcp-http",
    url: "https://a.example/mcp",
  };
  const replacement = { ...original, url: "https://b.example/mcp" };

  try {
    const team = await (
      await fetch(`${base}/api/teams`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Project",
          memory: "",
          integrations: [original],
        }),
      })
    ).json();
    await fetch(`${base}/api/teams/${team.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ integrations: [replacement] }),
    });
    const response = await fetch(
      `${base}/api/teams/${team.id}/integrations/remote/credentials`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "BEARER_TOKEN",
          value: "private-a-token",
          expectedIntegration: original,
        }),
      },
    );
    expect(response.status).toBe(409);
    await expect(
      Fs.stat(join(root, "team-auth", team.id, "remote", "environment.json")),
    ).rejects.toThrow();
  } finally {
    await app.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
