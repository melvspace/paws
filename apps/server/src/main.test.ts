import * as Fs from "node:fs/promises";
import { once } from "node:events";
import { Effect, Schema } from "effect";
import { makeAgentService } from "./AgentService.ts";
import { Agent, Conversation } from "@paws/contracts";
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
    const skills = await fetch(`${base}/api/agents/${agent.id}/chat/skills`);
    expect(skills.status).toBe(200);
    expect(await skills.json()).toEqual([]);
    const missingSkills = await fetch(`${base}/api/agents/missing/chat/skills`);
    expect(missingSkills.status).toBe(404);
    const upload = await fetch(`${base}/api/agents/${agent.id}/chat/uploads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent("notes.txt"),
      },
      body: "hello",
    });
    expect(upload.status).toBe(201);
    const uploadedFile = await upload.json();
    expect(uploadedFile).toMatchObject({
      name: "notes.txt",
      size: 5,
      mediaType: "application/octet-stream",
    });
    const invalidUpload = await fetch(
      `${base}/api/agents/${agent.id}/chat/uploads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: "hello",
      },
    );
    expect(invalidUpload.status).toBe(400);
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

it("accepts chat messages, broadcasts replies, returns validation errors and rejects cross-origin sends", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-chat-http-");
  let turns = 0;
  const app = createServer(root, {
    discoverProviders: async () => ({
      auth: "authenticated",
      version: "test",
      models: [{ id: "test-model", name: "Test", options: [] }],
    }),
    runChat: async (turn) => {
      turns++;
      turn.onThread("native-thread");
      turn.onMessage("answer", {
        text: "Hello from your agent",
        actions: [],
        fields: [],
      });
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");

  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "Content-Type": "application/json" };
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const snapshots: { conversations?: Conversation[] }[] = [];
  socket.on("message", (data) => snapshots.push(JSON.parse(String(data))));

  try {
    await once(socket, "open");
    const configured = await fetch(`${base}/api/providers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ driver: "codex" }),
    });
    const provider = await configured.json();
    await app.providers.refresh(provider.config.id);
    const created = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    });
    const agent = await created.json();
    const url = `${base}/api/agents/${agent.id}/chat`;
    const body = JSON.stringify({
      requestId: "request",
      text: "Hello",
      selection: {
        providerId: provider.config.id,
        modelId: "test-model",
        options: {},
      },
    });
    const foreign = await fetch(url, {
      method: "POST",
      headers: { ...headers, Origin: "https://foreign.example" },
      body,
    });
    expect(foreign.status).toBe(403);
    const accepted = await fetch(url, { method: "POST", headers, body });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: "running" });
    await expect
      .poll(() =>
        snapshots.some((snapshot) =>
          snapshot.conversations?.some((chat) =>
            chat.messages.some(
              (message) => message.text === "Hello from your agent",
            ),
          ),
        ),
      )
      .toBe(true);
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(
      200,
    );
    expect(turns).toBe(1);
    const conversation = Schema.decodeUnknownSync(Conversation)(
      await (await fetch(url)).json(),
    );
    const lastMessage = conversation.messages.at(-1)!;
    expect(conversation.unreadCount).toBe(1);
    const readResponse = await fetch(`${url}/read`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messageId: lastMessage.id }),
    });
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      lastReadMessageId: lastMessage.id,
      unreadCount: 0,
    });
    await expect
      .poll(() =>
        snapshots.some((snapshot) =>
          snapshot.conversations?.some(
            (item) =>
              item.lastReadMessageId === lastMessage.id &&
              item.unreadCount === 0,
          ),
        ),
      )
      .toBe(true);
    const invalidRead = await fetch(`${url}/read`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messageId: "missing" }),
    });
    expect(invalidRead.status).toBe(400);
    const foreignRead = await fetch(`${url}/read`, {
      method: "POST",
      headers: { ...headers, Origin: "https://foreign.example" },
      body: JSON.stringify({ messageId: lastMessage.id }),
    });
    expect(foreignRead.status).toBe(403);
    const conflict = await fetch(url, {
      method: "POST",
      headers,
      body: body.replace('"Hello"', '"Different"'),
    });
    expect(conflict.status).toBe(409);
    const unknown = await fetch(`${base}/api/agents/missing/chat`);
    expect(unknown.status).toBe(404);
    const stopped = await fetch(`${url}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    const noContinuation = await fetch(`${url}/continue`, { method: "POST" });
    expect(noContinuation.status).toBe(409);
    const missingQueued = await fetch(`${url}/queue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "resume", requestId: "missing" }),
    });
    expect(missingQueued.status).toBe(409);
    const invalidQueueAction = await fetch(`${url}/queue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "execute", requestId: "request" }),
    });
    expect(invalidQueueAction.status).toBe(400);
    await fetch(`${base}/api/agents/${agent.id}`, { method: "DELETE" });
    expect(app.chat.list()).toEqual([]);
  } finally {
    socket.terminate();
    await app.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("authorizes agent management in direct user turns and denies it for peer requests and returned replies", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-agent-tools-");
  const agents = makeAgentService(root);
  const requester = await Effect.runPromise(
    agents.create({ name: "Requester" }),
  );
  const worker = await Effect.runPromise(agents.create({ name: "Worker" }));
  const denied: string[] = [];
  const app = createServer(root, {
    discoverProviders: async () => ({
      auth: "authenticated",
      version: "test",
      models: [{ id: "test", name: "Test", options: [] }],
    }),
    runChat: async (turn) => {
      if (turn.requestId === "user-setup") {
        await turn.agentTool!({
          action: "create",
          name: "Specialist",
          role: "Reviewer",
        });
      } else {
        await expect(
          turn.agentTool!({ action: "create", name: "Unrequested" }),
        ).rejects.toThrow("direct user conversation");
        denied.push(turn.agentId);
      }

      turn.onText("result", "Checked", true);
    },
  });

  try {
    const provider = await Effect.runPromise(app.providers.create("codex"));
    await app.providers.refresh(provider.config.id);
    await Effect.runPromise(
      app.chat.send(requester.id, {
        requestId: "user-setup",
        text: "Create a reviewer agent",
        selection: {
          providerId: provider.config.id,
          modelId: "test",
          options: {},
        },
      }),
    );
    await app.chat.wait(requester.id);
    expect(
      (await Effect.runPromise(agents.list())).map((agent) => agent.name),
    ).toEqual(["Requester", "Worker", "Specialist"]);
    await app.teamwork.tool(requester.id, {
      action: "message",
      toAgentId: worker.id,
      text: "Check your setup",
    });
    await expect.poll(() => denied).toEqual([worker.id, requester.id]);
    expect(await Effect.runPromise(agents.list())).toHaveLength(3);
  } finally {
    await app.close();
    agents.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
