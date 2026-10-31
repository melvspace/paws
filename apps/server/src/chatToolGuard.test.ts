import { expect, it } from "vite-plus/test";
import type { ChatTurn } from "@paws/provider-core";
import { guardChatTools } from "./chatToolGuard.ts";
import { openToolBridge } from "../../../packages/provider-native/src/toolBridge.ts";
import { chatTools } from "../../../packages/provider-native/src/chatTools.ts";

function fixture() {
  const activity: string[] = [];
  const turn: ChatTurn = {
    agentId: "agent",
    agentName: "Ada",
    nativeThreadId: null,
    text: "Unpack this archive",
    selection: { providerId: "opencode", modelId: "model", options: {} },
    signal: new AbortController().signal,
    onThread() {},
    onText() {},
    onMessage() {},
    onTool: (name, status) => {
      activity.push(`${name}:${status}`);
    },
  };

  return { turn, activity, guarded: guardChatTools(turn) };
}

it("prompts an update after silent work and repeated failures without stopping a known alternative", () => {
  const { guarded, activity } = fixture();

  for (let index = 0; index < 7; index++) {
    guarded.onTool?.("paws_exec", "running");
    expect(guarded.onTool?.("paws_exec", "completed")).toBeUndefined();
  }

  guarded.onTool?.("paws_exec", "running");
  expect(guarded.onTool?.("paws_exec", "completed")).toContain("update");
  guarded.onText("progress", "The files are unpacked; I am checking them.");
  guarded.onTool?.("paws_exec", "running");
  expect(guarded.onTool?.("paws_exec", "failed")).toBeUndefined();
  guarded.onTool?.("paws_exec", "running");
  expect(guarded.onTool?.("paws_exec", "failed")).toContain("help");
  expect(guarded.signal.aborted).toBe(false);
  expect(activity).toContain("paws_exec:failed");
});

it("blocks further work until an update is actually delivered", () => {
  const { guarded } = fixture();

  for (let index = 0; index < 8; index++) {
    guarded.onTool?.("paws_exec", "running");
    guarded.onTool?.("paws_exec", "completed");
  }

  expect(guarded.onTool?.("paws_exec", "running")).toContain("update");
  guarded.onText(
    "progress",
    "The archive is unpacked. The converter failed; I will inspect the SVG source.",
  );
  expect(guarded.onTool?.("paws_exec", "running")).toBeUndefined();
  expect(guarded.signal.aborted).toBe(false);
});

it("caps total work even when a provider reports progress", () => {
  const { guarded } = fixture();

  for (let index = 0; index < 100; index++) {
    guarded.onTool?.("paws_exec", "running");
    guarded.onTool?.("paws_exec", "completed");
    guarded.onText(`progress-${index}`, `Completed step ${index}.`, true);
  }

  // Even repeated commentary cannot bypass the overall turn budget.
  guarded.onText("progress", "Still trying.");
  expect(() => guarded.onTool?.("paws_exec", "running")).toThrow("tool limit");
  expect(guarded.signal.aborted).toBe(true);
  expect(guarded.signal.reason.message).toContain("partial results");
});

it("leaves communication available at the budget and resets silence only for visible output", async () => {
  const { guarded } = fixture();

  for (let index = 0; index < 100; index++) {
    guarded.onTool?.("paws_exec", "running");
    guarded.onTool?.("paws_exec", "completed");
    guarded.onText(`progress-${index}`, `Completed step ${index}.`, true);
  }

  expect(() => guarded.onTool?.("paws_send_message", "running")).not.toThrow();
  await guarded.onMessage("help", {
    text: "The converter failed. Can you provide PNG exports?",
    actions: [],
    fields: [],
  });
  guarded.onTool?.("paws_send_message", "completed");
  expect(guarded.signal.aborted).toBe(false);
});

it("warns at 80 calls and blocks work at 90 until a final report is delivered", async () => {
  const { turn, guarded } = fixture();
  const reports: string[] = [];
  turn.onMessage = (_id, card) => {
    reports.push(card.text);
  };
  let executions = 0;
  const tools = chatTools(guarded, {
    execute: async () => {
      executions++;

      return "done";
    },
    deliverSecret: async () => "/private/secret",
  });
  const work = tools.find((tool) => tool.name === "paws_exec")!;
  const send = tools.find((tool) => tool.name === "paws_send_message")!;

  for (let count = 1; count <= 90; count++) {
    const result = await work.execute({ command: "true" });
    const output = JSON.stringify(result);

    if (count === 80) {
      expect(output).toContain("tool budget warning");
      expect(output).toContain("final status report");
      expect(output).toContain("100");
    }

    if (count === 90) expect(output).toContain("final status report required");

    // Streaming progress is visible but is not a completed final report.
    guarded.onText(`progress-${count}`, `Completed step ${count}.`, false);
  }

  expect(await work.execute({ command: "true" })).toMatchObject({
    isError: true,
  });
  expect(executions).toBe(90);
  expect(reports).toEqual([]);
  await send.execute({
    text: "Unpacked the archive. Preview conversion failed. The SVG files are available; PNG exports would help finish the preview.",
    actions: [],
    fields: [],
  });
  expect(reports).toHaveLength(1);
  await work.execute({ command: "cleanup" });
  expect(executions).toBe(91);
  expect(guarded.signal.aborted).toBe(false);
});

it("accepts a completed text report before the hard limit", () => {
  const { guarded } = fixture();

  for (let count = 1; count <= 90; count++) {
    guarded.onTool?.("paws_exec", "running");
    guarded.onTool?.("paws_exec", "completed");
    guarded.onText(`progress-${count}`, `Completed step ${count}.`, false);
  }

  expect(guarded.onTool?.("paws_exec", "running")).toContain("final status");
  guarded.onText(
    "final",
    "The files are unpacked; previews remain blocked.",
    true,
  );
  expect(guarded.onTool?.("paws_exec", "running")).toBeUndefined();
});

it("enforces checkpoints and cancellation through MCP even when a provider batches or ignores failures", async () => {
  const { guarded } = fixture();
  let executions = 0;
  const bridge = await openToolBridge(guarded, {
    execute: async () => {
      executions++;

      throw new Error("Private runtime diagnostic");
    },
    deliverSecret: async () => "/private/secret",
  });
  const call = async (
    name = "paws_exec",
    args: Record<string, unknown> = { command: "false" },
  ) => {
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });

    return response.text();
  };

  try {
    expect(await call()).not.toContain("Private runtime diagnostic");
    expect(await call()).toContain("ask for their help");

    expect(await call()).toContain("update");
    expect(executions).toBe(2);
    await call("paws_send_message", {
      text: "The converter failed; I will inspect the source instead.",
      actions: [],
      fields: [],
    });
    await call();
    await call();
    expect(executions).toBe(4);
    expect(await call()).toContain("update");
    expect(await call()).toContain("update");

    expect(await call()).toContain("Paws tool request rejected");
    expect(executions).toBe(4);
    expect(guarded.signal.aborted).toBe(true);
    expect(guarded.signal.reason.message).toContain("without reporting");
    expect(await call()).toContain("Paws tool request rejected");
    expect(executions).toBe(4);
  } finally {
    await bridge.close();
  }

  await expect(fetch(bridge.url)).rejects.toThrow();
});
