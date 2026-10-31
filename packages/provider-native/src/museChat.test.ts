import { expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import type { ChatTurn } from "@paws/provider-core";
import { runMuseTurn } from "./museChat.ts";

const state = vi.hoisted(() => ({
  notify: (_event: { method: string; params: unknown }) => {},
  close: vi.fn(async () => {}),
  command: vi.fn(
    async (
      _method: string,
      _params: unknown,
      _options?: unknown,
    ): Promise<unknown> => ({}),
  ),
}));
vi.mock("@muse-code/sdk", () => ({
  spawnMspConnection: () => ({
    close: state.close,
    initialize: async () => ({
      initializeResult: { grantedCapabilities: ["sessionMcp"] },
      connection: {
        mintCommandId: () => "native-id",
        command: state.command,
        onNotification: (listener: typeof state.notify) => {
          state.notify = listener;
        },
        onProtocolError() {},
        closed: new Promise<void>(() => {}),
      },
    }),
  }),
}));

it("Muse accepts completion before acknowledgement, cancels native input and closes its bridge", async () => {
  let bridgeUrl = "";
  state.command.mockImplementation(async (method, params) => {
    if (method === "session/start") {
      const input = z
        .object({
          config: z.object({
            mcpServers: z.object({ paws: z.object({ url: z.string() }) }),
          }),
        })
        .parse(params);
      bridgeUrl = input.config.mcpServers.paws.url;

      return { session: { sessionId: "native-id" } };
    }

    if (method === "turn/start") {
      state.notify({
        method: "userInput/requested",
        params: { sessionId: "native-id", userInputId: "input" },
      });
      state.notify({
        method: "item/completed",
        params: {
          sessionId: "native-id",
          item: {
            itemId: "reply",
            turnId: "native-id",
            kind: "agentMessage",
            text: "Hello",
          },
        },
      });
      state.notify({
        method: "turn/completed",
        params: {
          sessionId: "native-id",
          turnId: "native-id",
          terminal: "completed",
        },
      });
    }

    if (method === "session/compact") return { status: "noop" };

    return {};
  });
  const onText = vi.fn();
  const turn: ChatTurn = {
    agentId: "agent",
    agentName: "Ada",
    nativeThreadId: null,
    text: "Hi",
    selection: { providerId: "muse", modelId: "default", options: {} },
    signal: AbortSignal.timeout(5000),
    onThread() {},
    onText,
    onMessage() {},
  };
  const launch = {
    command: "muse",
    args: [],
    cwd: "/control",
    signal: turn.signal,
  };
  const runtime = { execute: async () => "", deliverSecret: async () => "" };
  await runMuseTurn(launch, turn, runtime);
  expect(onText).toHaveBeenCalledWith("reply", "Hello", true);
  expect(state.command).toHaveBeenCalledWith(
    "userInput/cancel",
    expect.objectContaining({ userInputId: "input" }),
  );
  expect(state.close).toHaveBeenCalledTimes(1);
  await expect(fetch(bridgeUrl)).rejects.toThrow();
  await expect(
    runMuseTurn(launch, { ...turn, operation: "compact" }, runtime),
  ).rejects.toThrow("no context to compact");
  expect(state.close).toHaveBeenCalledTimes(2);
  await expect(fetch(bridgeUrl)).rejects.toThrow();
});
