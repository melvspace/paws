import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { makeAgentService } from "./AgentService.ts";
import { expect, it, vi } from "vite-plus/test";
import { createServer } from "./main.ts";

it("keeps management endpoints off the dedicated webhook listener", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-routine-http-");
  const app = createServer(root);
  app.webhookServer.listen(0, "127.0.0.1");
  await once(app.webhookServer, "listening");
  const address = app.webhookServer.address();

  if (!address || typeof address === "string")
    throw new Error("Expected listener.");

  try {
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/agents`)).status).toBe(404);
    expect(
      (await fetch(`${base}/api/routine-preview`, { method: "POST" })).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${base}/hooks/routines/00000000-0000-4000-8000-000000000001`,
          { method: "POST", body: "{}" },
        )
      ).status,
    ).toBe(404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("blocks chat execution aliases for cancelled, expired and deleted routine runs", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-routine-http-");
  const agents = makeAgentService(root);
  const agent = await Effect.runPromise(agents.create({ name: "Ada" }));
  agents.close();
  const executed = vi.fn();
  const app = createServer(root, { runChat: executed });
  await app.routines.ready;
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string")
    throw new Error("Expected listener.");

  try {
    const base = `http://127.0.0.1:${address.port}`;
    const routine = app.routines.save(agent.id, {
      name: "Digest",
      instruction: "Summarize",
      enabled: false,
      trigger: { kind: "interval", minutes: 60 },
      missed: "skip",
      timeoutMinutes: 60,
    });
    const cancelled = app.routines.enqueue(routine.id, "manual");
    await app.routines.cancel(cancelled.id);
    const expired = app.routines.enqueue(routine.id, "manual");
    await app.routines.cancel(expired.id);
    const db = new DatabaseSync(`${root}/state.sqlite`);

    try {
      db.prepare("UPDATE routine_runs SET data = ? WHERE id = ?").run(
        JSON.stringify({
          ...app.routines.getRun(expired.id),
          status: "expired",
        }),
        expired.id,
      );
    } finally {
      db.close();
    }

    const deleted = app.routines.enqueue(routine.id, "manual");
    await app.routines.remove(routine.id);

    for (const run of [cancelled, expired, deleted]) {
      const path = `${base}/api/agents/${run.id}/chat`;
      expect((await fetch(path)).status).toBe(200);
      const metadata = await fetch(
        `${base}/api/routine-runs/${run.id}/details`,
      );
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({
        id: run.id,
        agentId: agent.id,
      });

      for (const suffix of ["", "/stop", "/continue", "/compact", "/queue"]) {
        const response = await fetch(`${path}${suffix}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: "bypass",
            text: "Run again",
            selection: { providerId: "codex", modelId: "model", options: {} },
          }),
        });
        expect(response.status).toBe(405);
      }

      expect(app.routines.getRun(run.id).status).toBe(
        run.id === expired.id ? "expired" : "cancelled",
      );
    }

    expect(
      (await fetch(`${base}/api/agents/${agent.id}/routines?before=invalid`))
        .status,
    ).toBe(400);
    const history = await fetch(
      `${base}/api/agents/${agent.id}/routines?before=1`,
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      runs: [],
      nextRunCursor: null,
    });
    expect(
      (
        await fetch(
          `${base}/api/routine-runs/00000000-0000-4000-8000-000000000001/details`,
        )
      ).status,
    ).toBe(404);

    expect(executed).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
