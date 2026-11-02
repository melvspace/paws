import * as Fs from "node:fs/promises";
import { once } from "node:events";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { createServer } from "./main.ts";
import { makeAgentService } from "./AgentService.ts";

const stop = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@paws/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paws/runtime")>()),
  stopEnvironment: stop,
}));

it("retains teams and sandbox agents after failed stops so HTTP deletion can be retried", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-delete-");
  const app = createServer(root);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string") throw new Error("No listener");

  const base = `http://127.0.0.1:${address.port}/api`;

  try {
    for (const [kind, body] of [
      ["teams", { name: "Team", memory: "" }],
      ["agents", { name: "Agent", sandbox: true }],
    ] as const) {
      const response = await fetch(`${base}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      const entity = await response.json();
      stop.mockRejectedValueOnce(new Error("Docker unavailable"));
      expect(
        (await fetch(`${base}/${kind}/${entity.id}`, { method: "DELETE" }))
          .status,
      ).toBe(400);
      const snapshot = await (await fetch(`${base}/agents`)).json();
      expect(snapshot[kind]).toContainEqual(
        expect.objectContaining({ id: entity.id }),
      );
      expect(
        (await fetch(`${base}/${kind}/${entity.id}`, { method: "DELETE" }))
          .status,
      ).toBe(204);
      const removed = await (await fetch(`${base}/agents`)).json();
      expect(removed[kind]).not.toContainEqual(
        expect.objectContaining({ id: entity.id }),
      );
    }
  } finally {
    stop.mockReset();
    await app.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("blocks membership changes during team deletion and environment changes during agent deletion", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-delete-locks-");
  const service = makeAgentService(root);
  const waiting = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();

  try {
    const team = (await Effect.runPromise(
      service.saveTeam({ name: "Team", memory: "" }),
    ))!;
    const agent = await Effect.runPromise(service.create({ name: "Agent" }));
    const removing = Effect.runPromise(
      service.removeTeam(team.id, async () => {
        started.resolve();
        await waiting.promise;
      }),
    );
    await started.promise;
    await expect(
      Effect.runPromise(service.create({ name: "New", teamId: team.id })),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        service.moveTeam(agent.id, { fromTeamId: null, toTeamId: team.id }),
      ),
    ).rejects.toThrow();
    waiting.resolve();
    expect(await removing).toBe(true);
    await Effect.runPromise(
      service.remove(agent.id, async () => {
        expect(service.changing(agent.id)).toBe(true);
        await expect(
          Effect.runPromise(
            service.update(agent.id, { name: "Agent", sandbox: true }),
          ),
        ).rejects.toThrow();
      }),
    );
    expect(service.changing(agent.id)).toBe(false);
  } finally {
    waiting.resolve();
    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
