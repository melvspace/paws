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
