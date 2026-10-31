import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import type {
  ProviderSnapshot,
  ProviderDriver,
  SendChat,
} from "@paws/contracts";
import type { ChatTurn, RunChatTurn } from "@paws/provider-core";
import { makeAgentService } from "./AgentService.ts";
import { makeChatService } from "./ChatService.ts";

const provider: ProviderSnapshot = {
  config: {
    id: "codex",
    driver: "codex",
    name: "Codex",
    enabled: true,
    binaryPath: "",
    args: [],
  },
  status: "ready",
  auth: "authenticated",
  version: "1",
  message: null,
  checkedAt: null,
  models: [{ id: "model", name: "Model", options: [] }],
};
const input = (requestId: string, text = "Hello"): SendChat => ({
  requestId,
  text,
  selection: { providerId: "codex", modelId: "model", options: {} },
});

async function setup(
  run: RunChatTurn,
  driver: ProviderDriver = "codex",
  additional: ProviderSnapshot[] = [],
) {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-chat-service-");
  const agents = makeAgentService(root);
  const agent = await Effect.runPromise(agents.create({ name: "Ada" }));
  const other = await Effect.runPromise(agents.create({ name: "Grace" }));
  const configured = { ...provider, config: { ...provider.config, driver } };
  let chat = makeChatService(root, () => [configured, ...additional], run);

  return {
    root,
    agent,
    other,
    get chat() {
      return chat;
    },
    async reopen() {
      await chat.close();
      chat = makeChatService(root, () => [configured, ...additional], run);
    },
    async [Symbol.asyncDispose]() {
      await chat.close();
      agents.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("persists per-agent history and native threads, streams messages, and deduplicates retries", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn);
    turn.onThread(`thread-${turn.agentId}`);
    turn.onText("text", "Hel");
    turn.onText("text", "Hello!");
  });
  const { agent, other } = fixture;
  await Effect.runPromise(fixture.chat.send(agent.id, input("first")));
  await expect.poll(() => fixture.chat.get(agent.id).status).toBe("idle");
  expect(fixture.chat.get(agent.id).messages.map((m) => m.text)).toEqual([
    "Hello",
    "Hello!",
  ]);
  expect(fixture.chat.get(other.id).messages).toEqual([]);
  await fixture.reopen();
  await Effect.runPromise(fixture.chat.send(agent.id, input("first")));
  expect(calls).toHaveLength(1);
  await Effect.runPromise(
    fixture.chat.send(agent.id, input("second", "Again")),
  );
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]?.nativeThreadId).toBe(`thread-${agent.id}`);
  expect(
    fixture.chat.get(agent.id).messages.filter((m) => m.role === "user"),
  ).toHaveLength(2);
  await expect(
    Effect.runPromise(fixture.chat.send(agent.id, input("first", "different"))),
  ).rejects.toThrow();
});

it("validates and consumes interactive replies once and sends their contents into the same thread", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn);
    turn.onThread("thread");

    if (calls.length === 1)
      turn.onMessage("card", {
        text: "Where should we go?",
        actions: [{ id: "go", label: "Let's go" }],
        fields: [
          {
            id: "city",
            label: "City",
            type: "select",
            required: true,
            choices: [{ id: "paris", label: "Paris" }],
          },
        ],
      });
  });
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("first")));
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  const reply = {
    messageId: "first:card",
    actionId: "go",
    values: { city: "paris" },
  };
  await expect(
    Effect.runPromise(
      fixture.chat.send(id, {
        ...input("invalid"),
        reply: { ...reply, values: { city: "unknown" } },
      }),
    ),
  ).rejects.toThrow();
  await expect(
    Effect.runPromise(
      fixture.chat.send(id, {
        ...input("missing"),
        reply: { ...reply, values: {} },
      }),
    ),
  ).rejects.toThrow();
  await Effect.runPromise(fixture.chat.send(id, { ...input("reply"), reply }));
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  expect(calls[1]?.text).toBe("");
  expect(calls[1]?.interaction).toMatchObject({
    source: "paws",
    type: "form_submitted",
    messageId: "first:card",
    action: { id: "go", label: "Let's go" },
    fields: [{ id: "city", value: "paris", displayValue: "Paris" }],
  });
  expect(
    fixture.chat.get(id).messages.filter((m) => m.role === "user"),
  ).toHaveLength(1);
  await fixture.reopen();
  expect(
    fixture.chat.get(id).messages.find((m) => m.card)?.interaction,
  ).toEqual({ ...calls[1]?.interaction, delivery: "delivered" });
  await expect(
    Effect.runPromise(fixture.chat.send(id, { ...input("repeat"), reply })),
  ).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

for (const mode of ["steer", "queue", "unsupported", "ambiguous"] as const) {
  it(`handles active interactions with a non-Codex adapter: ${mode}`, async () => {
    const calls: ChatTurn[] = [];
    const steered: string[] = [];
    let finish = () => {};
    await using fixture = await setup(async (turn) => {
      calls.push(turn);
      turn.onThread("native-thread");

      if (calls.length > 1) return;

      turn.onMessage("choice", {
        text: "Choose",
        actions: [{ id: "yes", label: "Yes" }],
        fields: [],
      });

      if (mode !== "unsupported")
        turn.onSteer?.(async (followUp) => {
          if (!("interaction" in followUp)) return "queue";

          const { interaction } = followUp;
          steered.push(interaction.eventId);

          if (mode === "ambiguous")
            throw new Error("Connection lost after sending");

          return mode === "steer" ? "accepted" : "queue";
        });

      await new Promise<void>((resolve) => {
        finish = resolve;
        turn.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      turn.onSteer?.(null);
    }, "claudeAgent");
    const id = fixture.agent.id;
    await Effect.runPromise(fixture.chat.send(id, input("first")));
    await expect.poll(() => fixture.chat.get(id).messages.length).toBe(2);
    const response = {
      ...input("choice-response"),
      reply: { messageId: "first:choice", actionId: "yes", values: {} },
    };
    await Effect.runPromise(fixture.chat.send(id, response));
    await Effect.runPromise(fixture.chat.send(id, response));

    if (mode !== "unsupported") await expect.poll(() => steered.length).toBe(1);

    const status = () =>
      fixture.chat.get(id).messages.find((m) => m.card)?.interaction?.delivery;
    await expect
      .poll(status)
      .toBe(
        mode === "steer"
          ? "steered"
          : mode === "ambiguous"
            ? "failed"
            : "queued",
      );
    expect(calls).toHaveLength(1);
    finish();
    await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
    expect(calls).toHaveLength(
      mode === "queue" || mode === "unsupported" ? 2 : 1,
    );

    if (calls[1]) {
      expect(calls[1].nativeThreadId).toBe("native-thread");
      expect(calls[1].interaction?.eventId).toBe("choice-response");
      expect(calls[1].text).toBe("");
    }

    expect(
      fixture.chat.get(id).messages.filter((m) => m.role === "user"),
    ).toHaveLength(1);
  });
}

it("cancels queued secret responses on stop and permits a fresh submission", async () => {
  const calls: ChatTurn[] = [];
  let consumed = "";
  await using fixture = await setup(async (turn) => {
    calls.push(turn);
    turn.onThread("thread");

    if (calls.length === 1) {
      turn.onMessage("secret", {
        text: "Connect",
        actions: [],
        fields: [],
        secretRequest: { label: "Token" },
      });
      await new Promise<void>((resolve) =>
        turn.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    } else {
      consumed = turn.consumeSecret!(turn.interaction!.secretRef!);
    }
  });
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("first")));
  await expect.poll(() => fixture.chat.get(id).messages.length).toBe(2);
  const reply = {
    messageId: "first:secret",
    actionId: "save",
    values: {},
    secret: "discarded-secret",
  };
  await Effect.runPromise(fixture.chat.send(id, { ...input("queued"), reply }));
  await fixture.chat.stop(id);
  expect(calls).toHaveLength(1);
  expect(fixture.chat.get(id).messages[1]?.interaction?.delivery).toBe(
    "cancelled",
  );
  expect(fixture.chat.get(id).status).toBe("idle");
  await Effect.runPromise(
    fixture.chat.send(id, {
      ...input("retry"),
      reply: { ...reply, secret: "new-secret" },
    }),
  );
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  expect(consumed).toBe("new-secret");
});

it("queues typed follow-ups in order and lets an explicit steer reach the active provider", async () => {
  const prompts: string[] = [];
  const steered: string[] = [];
  let finish = () => {};
  await using fixture = await setup(async (turn) => {
    prompts.push(turn.text);
    turn.onThread("native-thread");

    if (prompts.length > 1) return;

    turn.onSteer?.(async (followUp) => {
      if (!("text" in followUp)) return "queue";

      steered.push(followUp.text);

      return "accepted";
    });
    await new Promise<void>((resolve) => {
      finish = resolve;
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    turn.onSteer?.(null);
  }, "pi");
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("first", "Start")));
  await expect.poll(() => prompts.length).toBe(1);
  await Effect.runPromise(
    fixture.chat.send(id, { ...input("next", "Next task"), mode: "queue" }),
  );
  await Effect.runPromise(
    fixture.chat.send(id, { ...input("later", "Later task"), mode: "queue" }),
  );
  await Effect.runPromise(
    fixture.chat.send(id, { ...input("now", "Correction now"), mode: "steer" }),
  );
  await expect.poll(() => steered).toEqual(["Correction now"]);
  expect(prompts).toEqual(["Start"]);
  expect(
    fixture.chat.get(id).messages.find((message) => message.id === "next")
      ?.delivery,
  ).toBe("queued");
  finish();
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  expect(prompts).toEqual(["Start", "Next task", "Later task"]);
  expect(
    fixture.chat.get(id).messages.filter((message) => message.role === "user"),
  ).toHaveLength(4);
});

it("keeps secret values out of persisted messages and delivers them once to the owning turn", async () => {
  const secret = "test-private-token-not-for-production";
  const calls: ChatTurn[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn);
    turn.onThread("thread");

    if (calls.length === 1) {
      turn.onMessage("secret", {
        text: "Needed to connect the test service.",
        actions: [],
        fields: [],
        secretRequest: { label: "Service token" },
      });
    } else {
      const reference = turn.interaction!.secretRef!;
      expect(() => turn.consumeSecret!("wrong-reference")).toThrow();
      expect(turn.consumeSecret!(reference)).toBe(secret);
      expect(() => turn.consumeSecret!(reference)).toThrow();
    }
  });
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("first")));
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  const reply = {
    messageId: "first:secret",
    actionId: "save",
    values: {},
    secret,
  };
  await expect(
    Effect.runPromise(
      fixture.chat.send(fixture.other.id, {
        ...input("cross-agent"),
        reply,
      }),
    ),
  ).rejects.toThrow();
  await expect(
    Effect.runPromise(
      fixture.chat.send(id, {
        ...input("empty-secret"),
        reply: { ...reply, secret: "" },
      }),
    ),
  ).rejects.toThrow();
  await Effect.runPromise(fixture.chat.send(id, { ...input("saved"), reply }));
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  expect(calls[1]?.interaction?.type).toBe("secret_saved");
  expect(calls[1]?.text).toBe("");
  expect(JSON.stringify(fixture.chat.get(id))).not.toContain(secret);
  expect(
    fixture.chat.get(id).messages.filter((m) => m.role === "user"),
  ).toHaveLength(1);
  await fixture.reopen();
  expect(
    (await readFile(`${fixture.root}/state.sqlite`)).includes(
      Buffer.from(secret),
    ),
  ).toBe(false);
  await Effect.runPromise(fixture.chat.send(id, { ...input("saved"), reply }));
  expect(calls).toHaveLength(2);
  await expect(
    Effect.runPromise(fixture.chat.send(id, { ...input("another"), reply })),
  ).rejects.toThrow();
});

it("delivers a declined secret request as a harness event without a value", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn);
    turn.onThread("thread");

    if (calls.length === 1)
      turn.onMessage("secret", {
        text: "Connect a service.",
        actions: [],
        fields: [],
        secretRequest: { label: "Token" },
      });
  });
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("first")));
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  await Effect.runPromise(
    fixture.chat.send(id, {
      ...input("declined"),
      reply: { messageId: "first:secret", actionId: "decline", values: {} },
    }),
  );
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  expect(calls[1]?.interaction?.type).toBe("secret_declined");
  expect(calls[1]?.interaction?.secretRef).toBeUndefined();
  expect(calls[1]?.consumeSecret).toBeUndefined();
});

it("discards an unused secret when its turn fails and keeps failures generic", async () => {
  const secret = "synthetic-secret-failure-value";
  let failedTurn: ChatTurn | undefined;
  await using fixture = await setup(async (turn) => {
    turn.onThread("thread");

    if (turn.interaction) {
      failedTurn = turn;

      throw new Error(`Fake failure containing ${secret}`);
    }

    turn.onMessage("secret", {
      text: "Connect a service.",
      actions: [],
      fields: [],
      secretRequest: { label: "Token" },
    });
  });
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("first")));
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  await Effect.runPromise(
    fixture.chat.send(id, {
      ...input("saved"),
      reply: {
        messageId: "first:secret",
        actionId: "save",
        values: {},
        secret,
      },
    }),
  );
  await expect.poll(() => fixture.chat.get(id).status).toBe("error");
  expect(JSON.stringify(fixture.chat.get(id))).not.toContain(secret);
  expect(() =>
    failedTurn!.consumeSecret!(failedTurn!.interaction!.secretRef!),
  ).toThrow();
});

it("queues concurrent messages, rejects invalid models, stops work, and permits a new turn", async () => {
  let aborted = false;
  await using fixture = await setup(
    (turn) =>
      new Promise((_resolve, reject) => {
        turn.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  );
  const id = fixture.agent.id;
  await expect(
    Effect.runPromise(
      fixture.chat.send(id, {
        ...input("invalid"),
        selection: { providerId: "codex", modelId: "missing", options: {} },
      }),
    ),
  ).rejects.toThrow();
  await Effect.runPromise(fixture.chat.send(id, input("first")));
  await Effect.runPromise(fixture.chat.send(id, input("queued")));
  expect(fixture.chat.get(id).messages.at(-1)?.delivery).toBe("queued");
  await fixture.chat.stop(id);
  expect(aborted).toBe(true);
  expect(fixture.chat.get(id).status).toBe("idle");
  expect(fixture.chat.get(id).error).toBeNull();
  await Effect.runPromise(fixture.chat.send(id, input("second")));
  await fixture.chat.remove(id);
  expect(fixture.chat.list()).toEqual([]);
});

it("persists safe failure messages without provider secrets", async () => {
  await using fixture = await setup(async () => {
    throw new Error("sensitive-token-in-provider-error");
  });
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("first")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("error");
  expect(JSON.stringify(fixture.chat.list())).not.toContain("sensitive-token");
  await fixture.reopen();
  expect(fixture.chat.get(fixture.agent.id).status).toBe("error");
  expect(fixture.chat.get(fixture.agent.id).messages[0]?.text).toBe("Hello");
});

it("persists image-only replies, scopes access to the owner, and retains images after source deletion", async () => {
  await using fixture = await setup(async (turn) => {
    await turn.onImage!(
      "generated",
      "/home/agent/.codex/generated_images/test.png",
    );
  });
  const directory = `${fixture.root}/agents/${fixture.agent.id}/home/.codex/generated_images`;
  await mkdir(directory, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(`${directory}/test.png`, png);
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("image")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  const message = fixture.chat
    .get(fixture.agent.id)
    .messages.find((item) => item.attachments?.length)!;
  expect(message.text).toBe("");
  const attachment = message.attachments![0]!;
  expect(
    (await fixture.chat.attachment(fixture.agent.id, attachment.id)).data,
  ).toEqual(png);
  await expect(
    fixture.chat.attachment(fixture.other.id, attachment.id),
  ).rejects.toThrow("Attachment not found");
  await rm(`${directory}/test.png`);
  await fixture.reopen();
  expect(
    (await fixture.chat.attachment(fixture.agent.id, attachment.id)).data,
  ).toEqual(png);
});

it("recovers a completed native image without rerunning the turn and does not duplicate it", async () => {
  await using fixture = await setup(async (turn) => {
    turn.onThread("native");
  });
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("old")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  const home = `${fixture.root}/agents/${fixture.agent.id}/home/.codex`;
  await mkdir(`${home}/sessions`, { recursive: true });
  await mkdir(`${home}/generated_images`, { recursive: true });
  await writeFile(
    `${home}/generated_images/cat.png`,
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await writeFile(
    `${home}/sessions/rollout-native.jsonl`,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "native",
        item: {
          type: "Extension",
          kind: "image_gen.generation",
          id: "cat",
          status: "completed",
          savedPath: "/home/agent/.codex/generated_images/cat.png",
          failure: null,
        },
      },
    }) + "\n",
  );
  await fixture.reopen();
  await fixture.chat.recovery;
  expect(
    fixture.chat
      .get(fixture.agent.id)
      .messages.filter((item) => item.attachments?.length),
  ).toHaveLength(1);
  await fixture.reopen();
  await fixture.chat.recovery;
  expect(
    fixture.chat
      .get(fixture.agent.id)
      .messages.filter((item) => item.attachments?.length),
  ).toHaveLength(1);
});

it("rejects generated image paths that escape the agent home", async () => {
  const { saveGeneratedImage } = await import("./chatAttachments.ts");
  await using fixture = await setup(async () => {});
  const directory = `${fixture.root}/agents/${fixture.agent.id}/home/.codex/generated_images`;
  await mkdir(directory, { recursive: true });
  await writeFile(
    `${fixture.root}/outside.png`,
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await symlink(`${fixture.root}/outside.png`, `${directory}/escape.png`);
  await expect(
    saveGeneratedImage(
      fixture.root,
      fixture.agent.id,
      "/home/agent/.codex/generated_images/escape.png",
    ),
  ).rejects.toThrow("Invalid generated image path");
  await expect(
    saveGeneratedImage(fixture.root, fixture.agent.id, "/etc/passwd"),
  ).rejects.toThrow("Invalid generated image path");
});

it("persists context usage and compacts the existing thread without adding a user message", async () => {
  const operations: (string | undefined)[] = [];
  await using fixture = await setup(async (turn) => {
    operations.push(turn.operation);
    turn.onThread("context-thread");
    turn.onUsage?.({
      usedTokens: turn.operation === "compact" ? 1000 : 196000,
      maxTokens: 258000,
      totalProcessedTokens: 900000,
    });
  });
  await expect(
    Effect.runPromise(fixture.chat.compact(fixture.agent.id)),
  ).rejects.toThrow();
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("usage")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  await fixture.reopen();
  expect(fixture.chat.get(fixture.agent.id).contextUsage?.usedTokens).toBe(
    196000,
  );
  await Effect.runPromise(fixture.chat.compact(fixture.agent.id));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).contextUsage?.usedTokens)
    .toBe(1000);
  expect(operations).toEqual([undefined, "compact"]);
  expect(fixture.chat.get(fixture.agent.id).messages).toHaveLength(1);
});

it("hands a conversation to a different provider instead of locking its account", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(
    async (turn) => {
      calls.push(turn);
      turn.onThread(`native-${turn.selection.providerId}`);
      turn.onText("reply", "Remember the calico cat.");
    },
    "codex",
    [
      {
        ...provider,
        config: { ...provider.config, id: "claude", driver: "claudeAgent" },
      },
    ],
  );
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("first")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, {
      ...input("switch", "Continue"),
      selection: { providerId: "claude", modelId: "model", options: {} },
    }),
  );
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]?.nativeThreadId).toBeNull();
  expect(calls[1]?.handoff).toContain("Remember the calico cat.");
  expect(calls[1]?.handoff).not.toContain('"text":"Continue"');
  expect(calls[1]?.text).toBe("Continue");
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  await fixture.reopen();
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, input("back", "Back to you")),
  );
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(calls[2]?.nativeThreadId).toBe("native-codex");
  expect(calls[2]?.handoff).toContain('"text":"Continue"');
  expect(calls[2]?.handoff).not.toContain('"id":"first"');
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, input("same", "Again")),
  );
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(calls[3]?.nativeThreadId).toBe("native-codex");
  expect(calls[3]?.handoff).toBeUndefined();
  expect(fixture.chat.get(fixture.agent.id).handoffs).toEqual([
    {
      id: "switch",
      kind: "provider-switch",
      beforeMessageId: "switch",
      status: "completed",
      from: [
        {
          providerId: "codex",
          modelId: "model",
          name: "Model",
          driver: "codex",
        },
      ],
      to: {
        providerId: "claude",
        modelId: "model",
        name: "Model",
        driver: "claudeAgent",
      },
    },
    {
      id: "back",
      kind: "provider-switch",
      beforeMessageId: "back",
      status: "completed",
      from: [
        {
          providerId: "claude",
          modelId: "model",
          name: "Model",
          driver: "claudeAgent",
        },
      ],
      to: {
        providerId: "codex",
        modelId: "model",
        name: "Model",
        driver: "codex",
      },
    },
  ]);
});

it("queues a provider switch until the running provider finishes and transfers its final reply", async () => {
  const calls: ChatTurn[] = [];
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await using fixture = await setup(
    async (turn) => {
      calls.push(turn);
      turn.onThread(`native-${turn.selection.providerId}`);

      if (calls.length === 1) {
        turn.onSteer?.(async () => {
          throw new Error("Must not steer a different provider");
        });
        await wait;
        turn.onText("final", "The final answer before switching");
      }
    },
    "codex",
    [
      {
        ...provider,
        config: { ...provider.config, id: "claude", driver: "claudeAgent" },
      },
    ],
  );
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("one")));
  await expect.poll(() => calls.length).toBe(1);
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, {
      ...input("two", "Continue on Claude"),
      selection: { providerId: "claude", modelId: "model", options: {} },
    }),
  );
  expect(calls).toHaveLength(1);
  release();
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(calls[1]?.nativeThreadId).toBeNull();
  expect(calls[1]?.handoff).toContain("The final answer before switching");
  expect(calls[1]?.handoff).not.toContain('"text":"Continue on Claude"');
});

it("classifies queued switches using the preceding executed provider, including silent turns", async () => {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: ChatTurn[] = [];
  await using fixture = await setup(
    async (turn) => {
      calls.push(turn);
      turn.onThread(`native-${turn.selection.providerId}`);

      if (calls.length === 1) {
        await wait;
        turn.onText("reply", "Initial context");
      } else {
        turn.onFinish?.({ silent: true });
      }
    },
    "codex",
    [{ ...provider, config: { ...provider.config, id: "other" } }],
  );
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("first")));
  await expect.poll(() => calls.length).toBe(1);
  await Effect.runPromise(
    fixture.chat.send(id, {
      ...input("switch"),
      mode: "queue",
      selection: { providerId: "other", modelId: "model", options: {} },
    }),
  );
  await Effect.runPromise(
    fixture.chat.send(id, { ...input("back"), mode: "queue" }),
  );
  release();
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  expect(
    fixture.chat.get(id).handoffs?.map((event) => ({
      kind: event.kind,
      from: event.from.map((model) => model.providerId),
      to: event.to.providerId,
    })),
  ).toEqual([
    { kind: "provider-switch", from: ["codex"], to: "other" },
    { kind: "provider-switch", from: ["other"], to: "codex" },
  ]);
});

it("preserves every transferred source model on a real provider handoff", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(
    async (turn) => {
      calls.push(turn);
      turn.onThread(`native-${turn.selection.providerId}`);
      turn.onText("reply", `Context from ${turn.selection.providerId}`);
    },
    "codex",
    ["second", "third"].map((id) => ({
      ...provider,
      config: { ...provider.config, id },
    })),
  );
  const id = fixture.agent.id;

  for (const providerId of ["codex", "second", "third"]) {
    await Effect.runPromise(
      fixture.chat.send(id, {
        ...input(providerId),
        selection: { providerId, modelId: "model", options: {} },
      }),
    );
    await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  }

  expect(calls[2]?.handoff).toContain("Context from codex");
  expect(calls[2]?.handoff).toContain("Context from second");
  expect(fixture.chat.get(id).handoffs?.at(-1)).toMatchObject({
    kind: "provider-switch",
    from: [{ providerId: "codex" }, { providerId: "second" }],
    to: { providerId: "third" },
  });
});

it("restores a migrated session without misclassifying mixed-provider history as a switch", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(
    async (turn) => {
      calls.push(turn);
      turn.onThread(`native-${calls.length}`);
      turn.onText("reply", `Context from ${turn.selection.providerId}`);
    },
    "codex",
    [{ ...provider, config: { ...provider.config, id: "other" } }],
  );
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("first")));
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  const selection = { providerId: "other", modelId: "model", options: {} };
  await Effect.runPromise(
    fixture.chat.send(id, { ...input("switch"), selection }),
  );
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  const db = new DatabaseSync(`${fixture.root}/state.sqlite`);
  db.prepare(
    "UPDATE conversations SET data=json_remove(data, '$.providerSessions.other.harnessRevision') WHERE agent_id=?",
  ).run(id);
  db.close();
  await fixture.reopen();
  await Effect.runPromise(
    fixture.chat.send(id, { ...input("restore"), selection }),
  );
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  expect(calls[2]?.nativeThreadId).toBeNull();
  expect(calls[2]?.handoff).toContain("Context from codex");
  expect(calls[2]?.handoff).toContain("Context from other");
  expect(fixture.chat.get(id).handoffs?.at(-1)).toMatchObject({
    kind: "session-restoration",
    from: [{ providerId: "codex" }, { providerId: "other" }],
    to: { providerId: "other" },
    status: "completed",
  });
  await fixture.reopen();
  expect(fixture.chat.get(id).handoffs?.at(-1)?.kind).toBe(
    "session-restoration",
  );
});

it("retries an uncertain handoff with a fresh native session and preserves the original session", async () => {
  const calls: ChatTurn[] = [];
  const selected = { providerId: "claude", modelId: "model", options: {} };
  await using fixture = await setup(
    async (turn) => {
      calls.push(turn);
      turn.onThread(`native-${calls.length}`);

      if (calls.length === 2)
        throw new Error("Lost connection after context delivery");

      turn.onText("answer", "Keep this context");
    },
    "codex",
    [
      {
        ...provider,
        config: { ...provider.config, id: "claude", driver: "claudeAgent" },
      },
    ],
  );
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("one")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, {
      ...input("two"),
      selection: selected,
    }),
  );
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("error");
  await fixture.reopen();
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, {
      ...input("retry"),
      selection: selected,
    }),
  );
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(calls[2]?.nativeThreadId).toBeNull();
  expect(calls[2]?.handoff).toContain("Keep this context");
  expect(
    fixture.chat
      .get(fixture.agent.id)
      .handoffs?.map(({ id, status }) => ({ id, status })),
  ).toEqual([
    { id: "two", status: "failed" },
    { id: "retry", status: "completed" },
  ]);
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("back")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(calls[3]?.nativeThreadId).toBe("native-1");
});

it("recreates a non-resumable provider session once with full history", async () => {
  const { ChatSessionUnavailableError } = await import("@paws/provider-core");
  const calls: ChatTurn[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn);

    if (turn.nativeThreadId)
      throw new ChatSessionUnavailableError("Resume unavailable");

    turn.onThread(`native-${calls.length}`);
    turn.onText("reply", "The remembered answer");
  }, "acpRegistry");
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("first")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, input("second", "Continue")),
  );
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(calls).toHaveLength(3);
  expect(calls[2]?.nativeThreadId).toBeNull();
  expect(calls[2]?.handoff).toContain("The remembered answer");
  expect(calls[2]?.text).toBe("Continue");
});

it("attaches workspace media and documents durably, scopes downloads, and supports media seeking", async () => {
  const { createServer } = await import("node:http");
  const { chatHttp } = await import("./chatHttp.ts");
  await using fixture = await setup(async (turn) => {
    await turn.onMessage(
      "files",
      { text: "Here are the files.", actions: [], fields: [] },
      [
        { path: "/workspace/clip.mp4" },
        { path: "/workspace/report.pdf", name: "Отчёт.pdf" },
        { path: "/workspace/demo.html" },
      ],
    );
  });
  const workspace = `${fixture.root}/agents/${fixture.agent.id}/workspace`;
  await mkdir(workspace, { recursive: true });
  const video = Buffer.from([
    0,
    0,
    0,
    24,
    ...Buffer.from("ftypisom"),
    0,
    0,
    0,
    0,
  ]);
  await writeFile(`${workspace}/clip.mp4`, video);
  await writeFile(`${workspace}/report.pdf`, "%PDF-1.7 report");
  await writeFile(`${workspace}/demo.html`, "<script>alert(1)</script>");
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("files")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  const message = fixture.chat
    .get(fixture.agent.id)
    .messages.find((item) => item.attachments?.length)!;
  expect(message.attachments?.map((item) => item.mediaType)).toEqual([
    "video/mp4",
    "application/pdf",
    "application/octet-stream",
  ]);
  expect(message.attachments?.[0]?.size).toBe(video.length);
  await rm(workspace, { recursive: true });
  await fixture.reopen();
  const server = createServer((request, response) => {
    void chatHttp(request, response, fixture.chat);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("Missing listener");

  const url = `http://127.0.0.1:${address.port}/api/agents/${fixture.agent.id}/chat/attachments/`;

  try {
    const media = message.attachments![0]!;
    const range = await fetch(url + media.id, {
      headers: { Range: "bytes=4-7" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(
      `bytes 4-7/${video.length}`,
    );
    expect(await range.text()).toBe("ftyp");
    const suffix = await fetch(url + media.id, {
      headers: { Range: "bytes=-4" },
    });
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(video.subarray(-4));
    const invalid = await fetch(url + media.id, {
      headers: { Range: "bytes=999-" },
    });
    expect(invalid.status).toBe(416);
    const document = await fetch(url + message.attachments![1]!.id);
    expect(document.headers.get("content-disposition")).toContain(
      "attachment; filename*=UTF-8''%D0",
    );
    expect(document.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await fetch(url + message.attachments![2]!.id);
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("content-disposition")).toContain("attachment;");
    const forbidden = await fetch(
      url.replace(fixture.agent.id, fixture.other.id) + media.id,
    );
    expect(forbidden.status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("upgrades old harness sessions with a context handoff and current attachment tools", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn);
    turn.onThread(turn.nativeThreadId ?? `native-${calls.length}`);

    if (turn.operation === "compact") return;
    if (calls.length === 1)
      turn.onText("reply", "Remember the video in our workspace.");
    else
      await turn.onMessage(
        "file",
        { text: "Attached.", actions: [], fields: [] },
        [{ path: "/workspace/video.mp4" }],
      );
  });
  const workspace = `${fixture.root}/agents/${fixture.agent.id}/workspace`;
  await mkdir(workspace, { recursive: true });
  await writeFile(
    `${workspace}/video.mp4`,
    Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom")]),
  );
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("first")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  const db = new DatabaseSync(`${fixture.root}/state.sqlite`);
  db.prepare(
    "UPDATE conversations SET data=json_remove(data, '$.providerSessions.codex.harnessRevision') WHERE agent_id=?",
  ).run(fixture.agent.id);
  db.close();
  await fixture.reopen();
  await Effect.runPromise(fixture.chat.compact(fixture.agent.id));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(calls[1]?.nativeThreadId).toBe("native-1");
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, input("upgrade", "Attach the video")),
  );
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(calls[2]?.nativeThreadId).toBeNull();
  expect(calls[2]?.handoff).toContain("Remember the video");
  expect(
    fixture.chat.get(fixture.agent.id).messages.at(-1)?.attachments?.[0]
      ?.mediaType,
  ).toBe("video/mp4");
  expect(fixture.chat.get(fixture.agent.id).handoffs?.at(-1)).toMatchObject({
    id: "upgrade",
    status: "completed",
  });
  await fixture.reopen();
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("resume")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(calls[3]?.nativeThreadId).toBe("native-3");
  expect(calls[3]?.handoff).toBeUndefined();
});

it("tracks completed messages independently of the turn and releases interrupted text", async () => {
  let activeTurn: ChatTurn | undefined;
  await using fixture = await setup(async (turn) => {
    activeTurn = turn;
    turn.onText("reply", "Partial");
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, input("display")),
  );
  await expect.poll(() => activeTurn !== undefined).toBe(true);
  const reply = () => fixture.chat.get(fixture.agent.id).messages.at(-1);
  expect(reply()).toMatchObject({ text: "Partial", streaming: true });
  activeTurn!.onText("reply", "Complete reply", true);
  expect(reply()).toMatchObject({ text: "Complete reply", streaming: false });
  expect(fixture.chat.get(fixture.agent.id).status).toBe("running");
  await activeTurn!.onMessage("card", {
    text: "Choose now",
    actions: [{ id: "yes", label: "Yes" }],
    fields: [],
  });
  expect(reply()).toMatchObject({ text: "Choose now", streaming: false });
  activeTurn!.onText("next", "Interrupted reply");
  await fixture.chat.stop(fixture.agent.id);
  expect(reply()).toMatchObject({
    text: "Interrupted reply",
    streaming: false,
  });
  await fixture.reopen();
  expect(reply()).toMatchObject({
    text: "Interrupted reply",
    streaming: false,
  });
});

it("preserves unsent messages when the server shuts down and reopens", async () => {
  const calls: string[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn.text);
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("working", "Work")));
  await expect.poll(() => calls.length).toBe(1);
  await Effect.runPromise(fixture.chat.send(id, input("waiting", "Make 2k")));
  await fixture.reopen();
  expect(fixture.chat.get(id).messages.at(-1)?.delivery).toBe("queued");
  expect(fixture.chat.get(id).messages[0]?.delivery).toBe("delivered");
  expect(calls).toEqual(["Work"]);
});

it("recovers a crash snapshot, keeps selected models, edits/removes held inputs and resumes once", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(
    async (turn) => {
      calls.push(turn);
      turn.onThread(`native-${turn.selection.providerId}`);

      if (calls.length === 1) {
        turn.onText("partial", "Unfinished");
        await new Promise<void>((resolve) => {
          turn.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
    },
    "codex",
    [
      {
        ...provider,
        config: { ...provider.config, id: "other", driver: "opencode" },
      },
    ],
  );
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("working", "Work")));
  await expect.poll(() => calls.length).toBe(1);
  await Effect.runPromise(
    fixture.chat.send(id, {
      ...input("first-queued", "Make 2k"),
      selection: { ...input("unused").selection, providerId: "other" },
    }),
  );
  await Effect.runPromise(
    fixture.chat.send(id, input("second-queued", "Remove me")),
  );
  const db = new DatabaseSync(`${fixture.root}/state.sqlite`);
  const snapshot = String(
    db.prepare("SELECT data FROM conversations WHERE agent_id = ?").get(id)
      ?.data,
  );
  await fixture.chat.close();
  // Restore exactly what was durable before an abrupt process loss.
  db.prepare("UPDATE conversations SET data = ? WHERE agent_id = ?").run(
    snapshot,
    id,
  );
  db.close();
  await fixture.reopen();
  const recovered = fixture.chat.get(id);
  expect(recovered.interrupted?.requestId).toBe("working");
  expect(
    recovered.queue?.map((entry) => [entry.requestId, entry.held]),
  ).toEqual([
    ["first-queued", true],
    ["second-queued", true],
  ]);
  expect(
    recovered.messages.find((message) => message.id === "working:partial")
      ?.streaming,
  ).toBe(false);
  expect(calls).toHaveLength(1);
  await Effect.runPromise(
    fixture.chat.updateQueue(id, {
      action: "edit",
      requestId: "first-queued",
      text: "Make 4k",
    }),
  );
  await Effect.runPromise(
    fixture.chat.updateQueue(id, {
      action: "remove",
      requestId: "second-queued",
    }),
  );
  await fixture.reopen();
  expect(fixture.chat.get(id).queue?.map((entry) => entry.text)).toEqual([
    "Make 4k",
  ]);
  expect(
    fixture.chat
      .get(id)
      .messages.some((message) => message.id === "second-queued"),
  ).toBe(false);
  await Effect.runPromise(
    fixture.chat.updateQueue(id, {
      action: "resume",
      requestId: "first-queued",
    }),
  );
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  expect(calls).toHaveLength(2);
  expect(calls[1]?.text).toBe("Make 4k");
  expect(calls[1]?.selection.providerId).toBe("other");
  expect(fixture.chat.get(id).queue).toEqual([]);
  expect(
    fixture.chat
      .get(id)
      .messages.filter((message) => message.id === "first-queued"),
  ).toHaveLength(1);
  await expect(
    Effect.runPromise(
      fixture.chat.updateQueue(id, {
        action: "resume",
        requestId: "first-queued",
      }),
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

it("continues interrupted work through an internal event and respects explicit Stop", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn);
    turn.onThread("native");
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const id = fixture.agent.id;
  await Effect.runPromise(
    fixture.chat.send(id, input("working", "Original request")),
  );
  await expect.poll(() => calls.length).toBe(1);
  await fixture.reopen();
  expect(fixture.chat.get(id).interrupted).toBeDefined();
  await Effect.runPromise(fixture.chat.continueInterrupted(id));
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]?.text).toContain("Paws harness event");
  expect(calls[1]?.nativeThreadId).toBe("native");
  expect(
    fixture.chat
      .get(id)
      .messages.filter((message) => message.role === "user")
      .map((message) => message.text),
  ).toEqual(["Original request"]);
  await Effect.runPromise(
    fixture.chat.send(id, input("waiting", "Queued before stop")),
  );
  await fixture.chat.stop(id);
  await fixture.reopen();
  expect(fixture.chat.get(id).interrupted).toBeUndefined();
  expect(fixture.chat.get(id).queue).toEqual([]);
  expect(fixture.chat.get(id).messages.at(-1)?.delivery).toBe("cancelled");
  await expect(
    Effect.runPromise(fixture.chat.continueInterrupted(id)),
  ).rejects.toThrow();
});

it("recovers queued form responses but requires secrets to be entered again", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn);
    turn.onThread("native");

    if (calls.length === 1) {
      await turn.onMessage("form", {
        text: "Choose",
        actions: [{ id: "yes", label: "Yes" }],
        fields: [],
      });
      await turn.onMessage("secret", {
        text: "Connect",
        actions: [],
        fields: [],
        secretRequest: { label: "Token" },
      });
      await new Promise<void>((resolve) => {
        turn.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  });
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("working")));
  await expect.poll(() => fixture.chat.get(id).messages.length).toBe(3);
  await Effect.runPromise(
    fixture.chat.send(id, {
      ...input("answer"),
      reply: { messageId: "working:form", actionId: "yes", values: {} },
    }),
  );
  await Effect.runPromise(
    fixture.chat.send(id, {
      ...input("credential"),
      reply: {
        messageId: "working:secret",
        actionId: "save",
        values: {},
        secret: "private-test-value",
      },
    }),
  );
  expect(JSON.stringify(fixture.chat.get(id))).not.toContain(
    "private-test-value",
  );
  await fixture.reopen();
  expect(fixture.chat.get(id).queue?.map((entry) => entry.requestId)).toEqual([
    "answer",
  ]);
  expect(
    fixture.chat
      .get(id)
      .messages.find((message) => message.id === "working:secret")?.interaction
      ?.delivery,
  ).toBe("cancelled");
  await Effect.runPromise(
    fixture.chat.updateQueue(id, { action: "resume", requestId: "answer" }),
  );
  await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
  expect(calls[1]?.interaction?.action.id).toBe("yes");
  expect(calls[1]?.text).toBe("");
  expect(
    fixture.chat.get(id).messages.filter((message) => message.role === "user"),
  ).toHaveLength(1);
});

it("does not replay a queued message whose steering acknowledgement was lost in a crash", async () => {
  let steering = false;
  await using fixture = await setup(async (turn) => {
    turn.onSteer?.(async () => {
      steering = true;
      await new Promise<void>((resolve) => {
        turn.signal.addEventListener("abort", () => resolve(), { once: true });
      });

      return "queue";
    });
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const id = fixture.agent.id;
  await Effect.runPromise(fixture.chat.send(id, input("working")));
  await Effect.runPromise(
    fixture.chat.send(id, input("steering", "Possibly received")),
  );
  await expect.poll(() => steering).toBe(true);
  const db = new DatabaseSync(`${fixture.root}/state.sqlite`);
  const snapshot = String(
    db.prepare("SELECT data FROM conversations WHERE agent_id = ?").get(id)
      ?.data,
  );
  await fixture.chat.close();
  db.prepare("UPDATE conversations SET data = ? WHERE agent_id = ?").run(
    snapshot,
    id,
  );
  db.close();
  await fixture.reopen();
  expect(fixture.chat.get(id).queue).toEqual([]);
  expect(fixture.chat.get(id).messages.at(-1)?.delivery).toBe("failed");
  await expect(
    Effect.runPromise(
      fixture.chat.updateQueue(id, { action: "resume", requestId: "steering" }),
    ),
  ).rejects.toThrow();
});

it("holds a request persisted before execution without inventing an interrupted reply", async () => {
  let calls = 0;
  await using fixture = await setup(async () => {
    calls += 1;
  });
  const id = fixture.agent.id;
  Effect.runSync(fixture.chat.send(id, input("before-start", "Wait for me")));
  const db = new DatabaseSync(`${fixture.root}/state.sqlite`);
  const snapshot = String(
    db.prepare("SELECT data FROM conversations WHERE agent_id = ?").get(id)
      ?.data,
  );
  await fixture.chat.close();
  db.prepare("UPDATE conversations SET data = ? WHERE agent_id = ?").run(
    snapshot,
    id,
  );
  db.close();
  await fixture.reopen();
  const countBeforeResume = calls;
  expect(fixture.chat.get(id).queue?.map((entry) => entry.requestId)).toEqual([
    "before-start",
  ]);
  expect(fixture.chat.get(id).interrupted).toBeUndefined();
  await Effect.runPromise(
    fixture.chat.updateQueue(id, {
      action: "resume",
      requestId: "before-start",
    }),
  );
  await expect.poll(() => calls).toBe(countBeforeResume + 1);
});

it("delivers installed skills to any provider and steering while keeping user messages clean", async () => {
  const turns: ChatTurn[] = [];
  const steered: unknown[] = [];
  let finish = () => {};
  await using fixture = await setup(async (turn) => {
    turns.push(turn);
    turn.onThread("skill-thread");
    turn.onSteer?.(async (value) => {
      steered.push(value);

      return "accepted";
    });
    await new Promise<void>((resolve) => {
      finish = resolve;
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }, "opencode");
  const directory = `${fixture.root}/agents/${fixture.agent.id}/home/.agents/skills/writer`;
  await mkdir(directory, { recursive: true });
  await writeFile(
    `${directory}/SKILL.md`,
    "---\nname: writer\ndescription: Writing\n---\nWrite well.",
  );
  expect(
    await Effect.runPromise(fixture.chat.skills(fixture.agent.id)),
  ).toHaveLength(1);
  await Effect.runPromise(
    fixture.chat.send(
      fixture.agent.id,
      input("skill-first", "$writer draft this"),
    ),
  );
  await expect.poll(() => turns.length).toBe(1);
  expect(turns[0]?.text).toContain(
    "/home/agent/.agents/skills/writer/SKILL.md",
  );
  expect(fixture.chat.get(fixture.agent.id).messages[0]?.text).toBe(
    "$writer draft this",
  );
  await Effect.runPromise(
    fixture.chat.send(
      fixture.agent.id,
      input("skill-steer", "$writer make it shorter"),
    ),
  );
  await expect.poll(() => steered.length).toBe(1);
  expect(steered[0]).toMatchObject({
    text: expect.stringContaining("[Paws skill selections]"),
  });
  finish();
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
});

it("uploads user files, persists their message and queue metadata, and scopes image reads by conversation", async () => {
  const turns: ChatTurn[] = [];
  let finish = () => {};
  await using fixture = await setup(async (turn) => {
    turns.push(turn);
    turn.onThread("files-thread");
    await new Promise<void>((resolve) => {
      finish = resolve;
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const file = await Effect.runPromise(
    fixture.chat.upload(fixture.agent.id, "../cat.png", image),
  );
  expect(file.name).toBe("cat.png");
  expect(file.mediaType).toBe("image/png");
  expect(
    await readFile(
      `${fixture.root}/agents/${fixture.agent.id}/workspace/${file.path!.slice("/workspace/".length)}`,
    ),
  ).toEqual(image);
  expect(
    (await fixture.chat.attachment(fixture.agent.id, file.id)).data,
  ).toEqual(image);
  await expect(
    fixture.chat.attachment(fixture.other.id, file.id),
  ).rejects.toThrow();
  await expect(
    Effect.runPromise(
      fixture.chat.send(fixture.other.id, {
        ...input("cross-agent"),
        attachmentIds: [file.id],
      }),
    ),
  ).rejects.toThrow();
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, {
      ...input("with-image", ""),
      attachmentIds: [file.id],
    }),
  );
  await expect.poll(() => turns.length).toBe(1);
  expect(turns[0]?.text).toContain(file.path);
  const resolved = await turns[0]!.readAttachment!(file.id);
  expect(resolved).toMatchObject({
    name: "cat.png",
    mediaType: "image/png",
    path: expect.stringMatching(/^\/workspace\//),
  });
  expect(await turns[0]!.viewImage!(resolved.path)).toEqual({
    mimeType: "image/png",
    data: image.toString("base64"),
  });
  await expect(turns[0]!.viewImage!("/etc/passwd")).rejects.toThrow();
  await expect(turns[0]!.readAttachment!("unknown")).rejects.toThrow();
  expect(fixture.chat.get(fixture.agent.id).messages[0]?.attachments).toEqual([
    file,
  ]);
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, {
      ...input("queued-image", "Look again"),
      mode: "queue",
      attachmentIds: [file.id],
    }),
  );
  await fixture.reopen();
  expect(fixture.chat.get(fixture.agent.id).queue?.[0]).toMatchObject({
    requestId: "queued-image",
    attachmentIds: [file.id],
    held: true,
  });
  await Effect.runPromise(
    fixture.chat.updateQueue(fixture.agent.id, {
      action: "resume",
      requestId: "queued-image",
    }),
  );
  await expect.poll(() => turns.length).toBe(2);
  expect(turns[1]?.text).toContain(file.path);
  finish();
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
});

it("completes context handoff on the first reply, independently of the remaining turn", async () => {
  const calls: ChatTurn[] = [];
  let failReply: (error: Error) => void = () => {};
  await using fixture = await setup(
    async (turn) => {
      calls.push(turn);
      turn.onThread(`native-${calls.length}`);

      if (calls.length === 1) {
        turn.onText("reply", "Remember this context.", true);

        return;
      }

      await new Promise<void>((_resolve, reject) => {
        failReply = reject;
      });
    },
    "codex",
    [{ ...provider, config: { ...provider.config, id: "other" } }],
  );
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("seed")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, {
      ...input("switch"),
      selection: { providerId: "other", modelId: "model", options: {} },
    }),
  );
  await expect.poll(() => calls.length).toBe(2);
  expect(fixture.chat.get(fixture.agent.id).handoffs?.at(-1)?.status).toBe(
    "pending",
  );

  try {
    calls[1]!.onText("reply", "I will inspect the clip.");
    expect(fixture.chat.get(fixture.agent.id).status).toBe("running");
    expect(fixture.chat.get(fixture.agent.id).handoffs?.at(-1)?.status).toBe(
      "completed",
    );
  } finally {
    failReply(new Error("Later execution failed"));
  }

  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("error");
  expect(fixture.chat.get(fixture.agent.id).handoffs?.at(-1)?.status).toBe(
    "completed",
  );
});

it("silently completes without trailing text, cards or attachments and resets silence for the next turn", async () => {
  let count = 0;
  await using fixture = await setup(async (turn) => {
    turn.onThread("silent-thread");
    count += 1;

    if (count !== 2) {
      turn.onText("answer", "An ordinary reply", true);

      return;
    }

    turn.onText("unfinished", "Staying");
    turn.onFinish?.({ silent: true });
    turn.onText("unfinished", "Staying quiet", true);
    turn.onText("final", "Got it", true);
    await turn.onMessage(
      "card",
      { text: "Acknowledged", actions: [], fields: [] },
      [{ path: "/workspace/does-not-exist.txt" }],
    );
    await turn.onImage?.("image", "/workspace/does-not-exist.png");
  });
  await Effect.runPromise(fixture.chat.send(fixture.agent.id, input("one")));
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, input("silent", "Don't reply")),
  );
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(
    fixture.chat.get(fixture.agent.id).messages.map((message) => message.id),
  ).toEqual(["one", "one:answer", "silent"]);
  await fixture.reopen();
  expect(fixture.chat.get(fixture.agent.id).messages).toHaveLength(3);
  await Effect.runPromise(
    fixture.chat.send(fixture.agent.id, input("three", "Reply now")),
  );
  await expect
    .poll(() => fixture.chat.get(fixture.agent.id).status)
    .toBe("idle");
  expect(fixture.chat.get(fixture.agent.id).messages.at(-1)?.text).toBe(
    "An ordinary reply",
  );
});

it.each(["message", "interaction"] as const)(
  "queues a %s after silent completion, even if the old provider re-registers steering",
  async (kind) => {
    const turns: ChatTurn[] = [];
    const steered: string[] = [];
    const releases: (() => void)[] = [];
    await using fixture = await setup(async (turn) => {
      turns.push(turn);
      turn.onThread("native-thread");
      turn.onSteer?.(async () => {
        steered.push(turn.text);
        turn.onText("steered-reply", "Reply to fresh steering", true);

        return "accepted";
      });

      if (turns.length === 1) {
        await turn.onMessage("choice", {
          text: "Choose when ready",
          actions: [{ id: "go", label: "Go" }],
          fields: [],
        });
      } else {
        turn.onText("reply", "Fresh turn can reply", true);
      }

      if (turns.length <= 2) {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          turn.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
    }, "pi");
    const id = fixture.agent.id;
    await Effect.runPromise(
      fixture.chat.send(id, input("silent-turn", "Stay quiet")),
    );
    await expect.poll(() => releases.length).toBe(1);
    turns[0]!.onFinish?.({ silent: true });
    // Late capability updates must not reopen a silently completed turn.
    turns[0]!.onSteer?.(async () => {
      steered.push("muted turn");

      return "accepted";
    });
    await Effect.runPromise(
      fixture.chat.send(id, {
        ...input("follow-up", kind === "message" ? "Reply now" : ""),
        mode: "steer",
        ...(kind === "interaction"
          ? {
              reply: {
                messageId: "silent-turn:choice",
                actionId: "go",
                values: {},
              },
            }
          : {}),
      }),
    );
    await Effect.runPromise(
      fixture.chat.send(id, {
        ...input("queued-after", "Next task"),
        mode: "queue",
      }),
    );
    expect(steered).toEqual([]);
    expect(turns).toHaveLength(1);
    expect(fixture.chat.get(id).queue?.map((entry) => entry.requestId)).toEqual(
      ["follow-up", "queued-after"],
    );
    releases[0]!();
    await expect.poll(() => releases.length).toBe(2);
    expect(turns[1]?.interaction?.type).toBe(
      kind === "interaction" ? "action_clicked" : undefined,
    );
    expect(
      fixture.chat
        .get(id)
        .messages.find((message) => message.id === "follow-up:reply")?.text,
    ).toBe("Fresh turn can reply");
    await Effect.runPromise(
      fixture.chat.send(id, {
        ...input("fresh-steer", "A correction"),
        mode: "steer",
      }),
    );
    await expect.poll(() => steered.length).toBe(1);
    expect(steered).not.toContain("muted turn");
    expect(
      fixture.chat
        .get(id)
        .messages.some((message) => message.text === "Reply to fresh steering"),
    ).toBe(true);
    releases[1]!();
    await expect.poll(() => fixture.chat.get(id).status).toBe("idle");
    expect(turns).toHaveLength(3);
    expect(turns[2]?.text).toBe("Next task");
  },
);
