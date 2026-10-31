import { expect, it, vi } from "vite-plus/test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { runClaudeTurn } from "./claudeChat.ts";
import type { ChatTurn } from "@paws/provider-core";

it("Claude preserves synthetic handoff and UI-event provenance, disables host tools and closes on failure", async () => {
  const close = vi.fn();
  const messages: SDKUserMessage[] = [];
  const controller = new AbortController();
  const turn: ChatTurn = {
    agentId: "agent",
    agentName: "Ada",
    nativeThreadId: "native-claude",
    text: "",
    handoff: "Earlier provider context",
    selection: {
      providerId: "claude",
      modelId: "sonnet",
      options: { effort: "high", fastMode: "true" },
    },
    signal: controller.signal,
    interaction: {
      source: "paws",
      type: "secret_saved",
      eventId: "event",
      messageId: "card",
      prompt: "Connect",
      action: { id: "save", label: "Token" },
      fields: [],
      secretRef: "reference",
    },
    onThread() {},
    onText() {},
    onMessage() {},
  };
  await expect(
    runClaudeTurn(
      {
        command: "claude",
        args: [],
        cwd: "/control",
        signal: controller.signal,
      },
      turn,
      {
        execute: async () => "",
        deliverSecret: async () => "/tmp/paws-secrets/file",
      },
      (input) => {
        expect(input.options).toMatchObject({
          resume: "native-claude",
          model: "sonnet",
          effort: "high",
          settings: { disableAllHooks: true, fastMode: true },
          tools: [],
          allowedTools: expect.arrayContaining(["mcp__paws__paws_finish_turn"]),
          settingSources: [],
          strictMcpConfig: true,
          plugins: [],
        });

        return {
          close,
          getContextUsage: async () => {
            throw new Error("No usage");
          },
          // oxlint-disable-next-line require-yield -- exercise unexpected stream closure after consuming input.
          async *[Symbol.asyncIterator]() {
            if (typeof input.prompt === "string")
              throw new Error("Expected structured input");

            for await (const message of input.prompt) messages.push(message);
          },
        };
      },
    ),
  ).rejects.toThrow("Claude ended before completing");
  expect(messages[0]).toMatchObject({
    isSynthetic: true,
    shouldQuery: false,
    message: { content: "Earlier provider context" },
  });
  expect(messages[1]).toMatchObject({
    isSynthetic: true,
    client_composed: true,
  });
  expect(JSON.stringify(messages[1])).toContain("/tmp/paws-secrets/file");
  expect(JSON.stringify(messages[1])).not.toContain("secretRef");
  expect(close).toHaveBeenCalledOnce();
});
