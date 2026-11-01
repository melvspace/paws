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
    await app.providers.refresh("codex");
    await Effect.runPromise(
      app.chat.send(agent.id, {
        requestId: "busy",
        text: "Work",
        selection: { providerId: "codex", modelId: "test-model", options: {} },
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
