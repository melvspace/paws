import * as Fs from "node:fs/promises";
import { once } from "node:events";
import { expect, it } from "vite-plus/test";
import { createServer } from "./main.ts";
import { memoryTool } from "./teamContext.ts";

it("lets users inspect and delete agent-managed entries but rejects creation and editing", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-memory-http-");
  const app = createServer(root);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string")
    throw new Error("Expected listener.");

  const base = `http://127.0.0.1:${address.port}`;
  const send = (
    path: string,
    body: unknown,
    method: "POST" | "PATCH" = "POST",
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    const agent = await (await send("/api/agents", { name: "Ada" })).json();
    const team = await (
      await send("/api/teams", { name: "Team", memory: "" })
    ).json();
    await send(`/api/agents/${agent.id}/move`, {
      fromTeamId: null,
      toTeamId: team.id,
    });

    for (const [kind, id] of [
      ["agents", agent.id],
      ["teams", team.id],
    ]) {
      memoryTool(root, agent.id, {
        action: "create",
        text: "Learned fact",
        ...(kind === "teams" ? { teamId: id } : {}),
      });
      const path = `/api/${kind}/${id}/memories`;
      const listed = await (await fetch(`${base}${path}`)).json();
      expect(listed).toMatchObject([{ text: "Learned fact" }]);
      expect(
        (await send(path, { action: "create", text: "User fact" })).status,
      ).toBe(403);
      expect(
        (
          await send(path, {
            action: "update",
            id: listed[0].id,
            text: "User edit",
            expected: "Learned fact",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await send(
            `/api/${kind}/${id}`,
            { name: "Changed", memory: "Bypass" },
            "PATCH",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await send(path, {
            action: "delete",
            id: listed[0].id,
            expected: "Stale fact",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await send(path, {
            action: "delete",
            id: listed[0].id,
            expected: "Learned fact",
          })
        ).status,
      ).toBe(200);
      expect(await (await fetch(`${base}${path}`)).json()).toEqual([]);
    }

    const denied = await fetch(`${base}/api/agents/${agent.id}/memories`, {
      headers: { Origin: "https://untrusted.example" },
    });
    expect(denied.status).toBe(403);
  } finally {
    await app.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
