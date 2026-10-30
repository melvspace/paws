import * as Fs from "node:fs/promises";
import { once } from "node:events";
import { Schema } from "effect";
import { Agent } from "@paws/contracts";
import { WebSocket } from "ws";
import { expect, it } from "vite-plus/test";
import { createServer } from "./main.ts";

it("creates, renames, and deletes an agent through HTTP with live updates", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-http-");
  const app = createServer(root);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected TCP listener");
  }

  const base = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);

  try {
    const [initial] = await once(socket, "message");
    expect(JSON.parse(String(initial))).toMatchObject({ agents: [] });
    const update = once(socket, "message");
    const response = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ada",
      }),
    });
    expect(response.status).toBe(201);
    const agent = Schema.decodeUnknownSync(Agent)(await response.json());
    const [message] = await update;
    expect(JSON.parse(String(message))).toMatchObject({ agents: [agent] });
    const roster = await fetch(`${base}/api/agents`);
    expect(await roster.json()).toMatchObject({ agents: [agent] });
    const invalid = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: 123,
      }),
    });
    expect(invalid.status).toBe(400);
    const wrongType = await fetch(`${base}/api/agents`, {
      method: "POST",
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
    const renameEvent = once(socket, "message");
    const renamedResponse = await fetch(`${base}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  Grace  " }),
    });
    expect(renamedResponse.status).toBe(200);
    const renamed = { ...agent, name: "Grace" };
    expect(await renamedResponse.json()).toEqual(renamed);
    const [renamedMessage] = await renameEvent;
    expect(JSON.parse(String(renamedMessage))).toMatchObject({
      agents: [renamed],
    });
    const missing = await fetch(`${base}/api/agents/missing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Grace" }),
    });
    expect(missing.status).toBe(404);
    const deleteEvent = once(socket, "message");
    const deleted = await fetch(`${base}/api/agents/${agent.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    const [deletedMessage] = await deleteEvent;
    expect(JSON.parse(String(deletedMessage))).toMatchObject({ agents: [] });
    const finalRoster = await fetch(`${base}/api/agents`);
    expect(await finalRoster.json()).toMatchObject({ agents: [] });
    const deleteMissing = await fetch(`${base}/api/agents/${agent.id}`, {
      method: "DELETE",
    });
    expect(deleteMissing.status).toBe(404);
  } finally {
    socket.terminate();
    const closed = once(app.server, "close");
    await app.close();
    await closed;
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("persists provider configuration, keeps secrets out of responses, and rejects foreign origins", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-provider-http-");
  const app = createServer(root);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");

  const base = `http://127.0.0.1:${address.port}/api/providers`;
  const headers = { "Content-Type": "application/json" };

  try {
    const created = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ driver: "acpRegistry" }),
    });
    expect(created.status).toBe(200);
    const provider = await created.json();
    const url = `${base}/${provider.config.id}`;
    const invalid = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ...provider.config, args: "--acp" }),
    });
    expect(invalid.status).toBe(400);
    const stored = await fetch(`${url}/environment`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "API_KEY", value: "test-secret" }),
    });
    expect(stored.status).toBe(200);
    expect(await stored.text()).not.toContain("test-secret");
    expect(await (await fetch(base)).text()).not.toContain("test-secret");
    const foreign = await fetch(`${url}/refresh`, {
      method: "POST",
      headers: { Origin: "https://foreign.example" },
    });
    expect(foreign.status).toBe(403);
    expect(
      (await fetch(`${base}/missing/refresh`, { method: "POST" })).status,
    ).toBe(404);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
  } finally {
    const closed = once(app.server, "close");
    await app.close();
    await closed;
    await Fs.rm(root, { recursive: true, force: true });
  }
});
