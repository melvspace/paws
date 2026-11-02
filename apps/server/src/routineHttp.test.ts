import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
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

it("rejects malformed raw request targets and keeps both listeners alive", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-routine-http-");
  const app = createServer(root);

  try {
    for (const server of [app.server, app.webhookServer]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();

      if (!address || typeof address === "string")
        throw new Error("Expected listener.");

      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const outgoing = request(
            {
              hostname: "127.0.0.1",
              port: address.port,
              path: "//[",
              method: "GET",
            },
            (response) => {
              response.resume();
              response.once("end", () => resolve(response.statusCode));
              response.once("error", reject);
            },
          );
          outgoing.once("error", reject);
          outgoing.end();
        },
      );
      expect(status).toBe(400);
      expect(server.listening).toBe(true);
      expect(
        (await fetch(`http://127.0.0.1:${address.port}/not-found`)).status,
      ).toBe(404);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("accepts plain JSON with a bearer secret and ignores provider-specific headers", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-routine-http-");
  const agents = makeAgentService(root);
  const agent = await Effect.runPromise(agents.create({ name: "Ada" }));
  agents.close();
  const app = createServer(root);
  await app.routines.ready;

  try {
    app.webhookServer.listen(0, "127.0.0.1");
    await once(app.webhookServer, "listening");
    const address = app.webhookServer.address();

    if (!address || typeof address === "string")
      throw new Error("Expected listener.");

    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    const management = app.server.address();

    if (!management || typeof management === "string")
      throw new Error("Expected listener.");

    const created = await fetch(
      `http://127.0.0.1:${management.port}/api/agents/${agent.id}/routines`,
      {
        method: "POST",
        body: JSON.stringify({
          routine: {
            name: "Incoming",
            instruction: "Summarize",
            enabled: true,
            trigger: {
              kind: "webhook",
              filters: { combinator: "and", rules: [] },
              eventType: "obsolete-filter",
            },
            missed: "skip",
            timeoutMinutes: 60,
          },
        }),
      },
    );
    expect(created.status).toBe(200);
    const creation = await created.json();
    const routine = creation.routine;
    expect(routine.trigger).toEqual({
      kind: "webhook",
      filters: { combinator: "and", rules: [] },
    });
    const managementPath = `/api/agents/${agent.id}/routines/${routine.id}/webhook`;
    const managementUrl = `http://127.0.0.1:${management.port}${managementPath}`;
    const configured = await fetch(managementUrl);
    expect(configured.status).toBe(200);
    const metadata = await configured.json();
    expect(metadata).toEqual({ endpoint: `/hooks/routines/${routine.id}` });
    const webhook = creation.webhook;
    expect(typeof webhook.secret).toBe("string");
    expect(await (await fetch(managementUrl)).json()).toEqual(metadata);
    expect(
      (await fetch(`http://127.0.0.1:${address.port}${managementPath}`)).status,
    ).toBe(404);
    const endpoint = `http://127.0.0.1:${address.port}${webhook.endpoint}`;
    const options = {
      method: "POST",
      body: '{"object_kind":"push"}',
      headers: { authorization: `Bearer ${webhook.secret}` },
    };
    expect((await fetch(endpoint, { ...options, headers: {} })).status).toBe(
      401,
    );
    expect(
      (
        await fetch(`${endpoint}?secret=${webhook.secret}`, {
          ...options,
          headers: {},
        })
      ).status,
    ).toBe(401);
    const accepted = await fetch(endpoint, options);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ outcome: "accepted" });
    const repeated = await fetch(endpoint, {
      ...options,
      headers: {
        ...options.headers,
        "x-gitlab-event": "Push Hook",
        "x-gitlab-token": "unused",
        "webhook-signature": "unused",
        "idempotency-key": "unused",
      },
    });
    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toMatchObject({ outcome: "accepted" });
    expect(app.routines.list(agent.id).runs).toHaveLength(2);
    expect((await fetch(endpoint)).status).toBe(405);
    expect(
      (await fetch(endpoint, { ...options, body: "invalid" })).status,
    ).toBe(400);
    expect(
      (await fetch(endpoint, { ...options, body: "x".repeat(262145) })).status,
    ).toBe(413);
    const rotated = await fetch(managementUrl, { method: "POST" });
    expect(rotated.status).toBe(200);
    const replacement = await rotated.json();
    expect(replacement.endpoint).toBe(webhook.endpoint);
    expect(replacement.secret).not.toBe(webhook.secret);
    expect((await fetch(endpoint, options)).status).toBe(401);
    expect(
      (
        await fetch(`http://127.0.0.1:${address.port}${replacement.endpoint}`, {
          ...options,
          headers: { authorization: `Bearer ${replacement.secret}` },
        })
      ).status,
    ).toBe(202);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
