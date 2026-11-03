import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { Conversation, Snapshot } from "@paws/contracts";
import { WebSocket } from "ws";
import { expect, it } from "vite-plus/test";
import { makeAgentService } from "./AgentService.ts";
import { createServer } from "./main.ts";

it("bounds HTTP, mutation responses and WebSocket snapshots while retaining persisted history", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-history-http-");
  const agents = makeAgentService(root);
  const agent = await Effect.runPromise(agents.create({ name: "History" }));
  agents.close();
  const db = new DatabaseSync(join(root, "state.sqlite"));
  const messages = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    role: index % 2 ? "assistant" : "user",
    text: `Message ${index}`,
    createdAt: "2026-01-01T00:00:00Z",
  }));
  db.exec(
    "CREATE TABLE conversations (agent_id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO conversations VALUES (?, ?)").run(
    agent.id,
    JSON.stringify({
      conversation: {
        agentId: agent.id,
        revision: 1,
        status: "idle",
        error: null,
        selection: null,
        messages,
      },
      nativeThreadId: null,
      requests: {},
    }),
  );
  db.close();
  const app = createServer(root);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");

  const base = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);

  try {
    const [data] = await once(socket, "message");
    const snapshot = Schema.decodeUnknownSync(Snapshot)(
      JSON.parse(String(data)),
    );
    expect(snapshot.conversations?.[0]?.messages).toHaveLength(20);
    const url = `${base}/api/agents/${agent.id}/chat`;
    const recent = Schema.decodeUnknownSync(Conversation)(
      await (await fetch(url)).json(),
    );
    expect(recent.messages).toHaveLength(20);
    expect(recent.unreadCount).toBe(50);
    const older = Schema.decodeUnknownSync(Conversation)(
      await (
        await fetch(
          `${url}?before=${encodeURIComponent(recent.historyCursor!)}`,
        )
      ).json(),
    );
    expect(older.messages.map((message) => message.id)).toEqual(
      messages.slice(40, 80).map((message) => message.id),
    );
    expect((await fetch(`${url}?before=bad`)).status).toBe(400);
    const read = await fetch(`${url}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "99" }),
    });
    expect(read.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(Conversation)(await read.json()).messages,
    ).toHaveLength(20);
    expect(app.chat.get(agent.id).messages).toHaveLength(100);
    expect(app.chat.get(agent.id).unreadCount).toBe(0);
  } finally {
    socket.terminate();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
