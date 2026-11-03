import { expect, it } from "vite-plus/test";
import { ChatToolError, type ChatTurn } from "@paws/provider-core";
import { chatTools } from "./chatTools.ts";

it("routes routine tools to the owner-bound callback and sanitizes unexpected failures", async () => {
  const calls: unknown[] = [];
  const turn: ChatTurn = {
    agentId: "owner",
    agentName: "Ada",
    nativeThreadId: null,
    text: "",
    selection: { providerId: "provider", modelId: "model", options: {} },
    signal: new AbortController().signal,
    onThread() {},
    onText() {},
    onMessage() {},
    async routineTool(input) {
      calls.push(input);

      if (calls.length === 2)
        throw new ChatToolError(
          "Routine changed. Reload its current revision.",
        );
      if (calls.length === 3) throw new Error("private-storage-details");

      return [{ id: "routine", agentId: "owner" }];
    },
  };
  const tool = chatTools(turn, {
    execute: async () => "",
    deliverSecret: async () => "",
  }).find((item) => item.name === "paws_routine");
  expect(tool).toBeDefined();
  expect(JSON.stringify(await tool!.execute({ action: "list" }))).toContain(
    "routine",
  );
  expect(JSON.stringify(await tool!.execute({ action: "list" }))).toContain(
    "Routine changed",
  );
  expect(JSON.stringify(await tool!.execute({ action: "list" }))).not.toContain(
    "private-storage-details",
  );
  expect(calls).toEqual([
    { action: "list" },
    { action: "list" },
    { action: "list" },
  ]);
});

it("routes teamwork to the agent-bound callback and exposes only safe failures", async () => {
  const calls: unknown[] = [];
  const turn: ChatTurn = {
    agentId: "owner",
    agentName: "Ada",
    nativeThreadId: null,
    text: "",
    selection: { providerId: "provider", modelId: "model", options: {} },
    signal: new AbortController().signal,
    onThread() {},
    onText() {},
    onMessage() {},
    async teamworkTool(value) {
      calls.push(value);

      if (calls.length === 2)
        throw new ChatToolError("Task changed. Reload it.");
      if (calls.length === 3) throw new Error("private-database-path");

      return {
        tasks: [],
        events: [],
        members: [{ id: "peer", name: "Grace" }],
      };
    },
  };
  const tool = chatTools(turn, {
    execute: async () => "",
    deliverSecret: async () => "",
  }).find((item) => item.name === "paws_teamwork")!;
  expect(JSON.stringify(await tool.execute({ action: "list" }))).toContain(
    "Grace",
  );
  expect(JSON.stringify(await tool.execute({ action: "list" }))).toContain(
    "Task changed",
  );
  expect(JSON.stringify(await tool.execute({ action: "list" }))).not.toContain(
    "private-database-path",
  );
  expect(calls).toEqual([
    { action: "list" },
    { action: "list" },
    { action: "list" },
  ]);
});

it("advertises peer files, broadcast and interruption, and routes safe agent management", async () => {
  const calls: unknown[] = [];
  const turn: ChatTurn = {
    agentId: "owner",
    agentName: "Ada",
    nativeThreadId: null,
    text: "",
    selection: { providerId: "provider", modelId: "model", options: {} },
    signal: new AbortController().signal,
    onThread() {},
    onText() {},
    onMessage() {},
    async agentTool(value) {
      calls.push(value);

      if (calls.length === 2) throw new ChatToolError("Agent must be idle.");
      if (calls.length === 3) throw new Error("PRIVATE_STORAGE_PATH");

      return { agent: { id: "reviewer", role: "Reviewer" } };
    },
  };
  const tools = chatTools(turn, {
    execute: async () => "",
    deliverSecret: async () => "",
  });
  const peer = tools.find((tool) => tool.name === "paws_teamwork")!;
  expect(
    peer.schema.parse({
      action: "message",
      toAgentIds: ["a", "b"],
      attachments: [{ path: "/workspace/report.pdf" }],
    }),
  ).toMatchObject({ toAgentIds: ["a", "b"] });
  expect(
    peer.schema.parse({
      action: "interrupt",
      toAgentId: "a",
      eventId: "request",
    }),
  ).toMatchObject({ action: "interrupt" });
  const management = tools.find((tool) => tool.name === "paws_agents")!;
  expect(
    JSON.stringify(
      await management.execute({ action: "create", name: "Reviewer" }),
    ),
  ).toContain("Reviewer");
  expect(
    JSON.stringify(await management.execute({ action: "update" })),
  ).toContain("Agent must be idle");
  expect(
    JSON.stringify(await management.execute({ action: "read" })),
  ).not.toContain("PRIVATE_STORAGE_PATH");
  expect(calls[0]).toEqual({ action: "create", name: "Reviewer" });
});
