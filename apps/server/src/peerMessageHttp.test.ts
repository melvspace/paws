import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { PeerRetryResult } from "@paws/contracts";
import { ChatExecutionError } from "@paws/provider-core";
import { resolveWorkspaceDirectory } from "@paws/runtime";
import { expect, it } from "vite-plus/test";
import { makeAgentService } from "./AgentService.ts";
import { createServer } from "./main.ts";

it("retries only a participant's stopped delivery with the original files and never exposes internal work", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-peer-retry-http-");
  const agents = makeAgentService(root);
  const requester = await Effect.runPromise(
    agents.create({ name: "Requester" }),
  );
  const worker = await Effect.runPromise(agents.create({ name: "Joker" }));
  const other = await Effect.runPromise(agents.create({ name: "Other" }));
  let fail = true;
  let fileReceived = false;
  let attempts = 0;
  const app = createServer(root, {
    discoverProviders: async () => ({
      auth: "authenticated",
      version: "test",
      models: [{ id: "model", name: "Test", options: [] }],
    }),
    runChat: async (turn) => {
      attempts++;

      if (fail) throw new ChatExecutionError("Model connection failed.");

      const message = app.teamwork.conversations
        .get(turn.conversationId!)
        .messages.find((item) => item.id === turn.requestId)!;
      fileReceived = Boolean(
        await turn.readAttachment!(message.attachments![0]!.id),
      );
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();

  if (!address || typeof address === "string")
    throw new Error("Expected listener.");

  const base = `http://127.0.0.1:${address.port}`;

  try {
    const provider = await Effect.runPromise(app.providers.create("codex"));
    await app.providers.refresh(provider.config.id);
    await writeFile(
      join(
        resolveWorkspaceDirectory(root, requester.id, "workspace"),
        "brief.txt",
      ),
      "Original file",
    );
    const state = await app.teamwork.tool(requester.id, {
      action: "message",
      toAgentId: worker.id,
      text: "Read the file",
      expectsReply: false,
      attachments: [{ path: "brief.txt" }],
    });
    const eventId = state.events[0]!.id;
    await expect
      .poll(() => app.teamwork.list(requester.id).events[0]?.delivery)
      .toBe("failed");
    const received = app.chat
      .get(worker.id)
      .messages.find((message) => message.peer?.eventId === eventId)!;
    expect(received.attachments).toHaveLength(1);
    expect(received.text).toBe("Read the file");
    const path = `/api/agents/${requester.id}/peer-messages/${eventId}/retry`;
    expect((await fetch(`${base}${path}`)).status).toBe(405);
    expect(
      (
        await fetch(`${base}${path}`, {
          method: "POST",
          headers: { Origin: "https://foreign.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          `${base}/api/agents/${other.id}/peer-messages/${eventId}/retry`,
          { method: "POST" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          `${base}/api/agents/${requester.id}/peer-messages/missing/retry`,
          { method: "POST" },
        )
      ).status,
    ).toBe(404);
    expect(app.teamwork.list(requester.id).events).toHaveLength(1);
    fail = false;
    const response = await fetch(`${base}${path}`, { method: "POST" });
    expect(response.status).toBe(202);
    const result = Schema.decodeUnknownSync(PeerRetryResult, {
      onExcessProperty: "error",
    })(await response.json());
    expect(result.requestId).not.toBe(eventId);
    await expect
      .poll(() => app.teamwork.list(requester.id).events.at(-1)?.delivery)
      .toBe("delivered");
    expect(fileReceived).toBe(true);
    expect((await fetch(`${base}${path}`, { method: "POST" })).status).toBe(
      409,
    );
    expect(attempts).toBe(2);
    expect(app.teamwork.list(requester.id).events).toHaveLength(2);
    const original = app.chat
      .get(requester.id)
      .messages.find((message) => message.peer?.eventId === eventId)!;
    expect(original.text).toBe("Read the file");
    expect(original.peer?.recovery).toMatchObject({
      retried: true,
      canRetry: false,
    });
  } finally {
    await app.close();
    agents.close();
    await rm(root, { recursive: true, force: true });
  }
});
