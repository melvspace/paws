import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vite-plus/test";
import type { ProbeLaunch } from "@paws/provider-core/process";
import { runOpenCodeTurn } from "./opencodeChat.ts";

const state = vi.hoisted(() => ({
  failed: false,
  error: undefined as unknown,
  modelFailure: false,
  inputLimit: 160000 as number | undefined,
  aborted: false,
  close: vi.fn(async () => {}),
}));

vi.mock("@paws/provider-core/process", () => ({
  withProcess: async (
    _launch: ProbeLaunch,
    run: (
      child: EventEmitter & { stdout: PassThrough },
      failure: Promise<never>,
    ) => Promise<void>,
  ) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
    });
    queueMicrotask(() =>
      child.stdout.write("server listening on http://127.0.0.1:12345"),
    );

    return run(child, new Promise<never>(() => {}));
  },
}));
vi.mock("./openCodeProtocol.ts", () => ({
  probeOpenCodeProtocol: async () => ({ generation: "v2", version: "2.2.5" }),
}));
vi.mock("./toolBridge.ts", () => ({
  openToolBridge: async () => ({
    url: "http://127.0.0.1:1",
    token: "fixture",
    close: state.close,
  }),
}));
vi.mock("@opencode/client", () => ({
  OpenCode: {
    make: () => ({
      model: {
        list: async () => {
          if (state.modelFailure) throw new Error("Catalog unavailable");

          return {
            data: [
              {
                providerID: "opencode",
                id: "deepseek-v4.1-flash-free",
                limit: { input: state.inputLimit, context: 200000 },
              },
            ],
          };
        },
      },
      session: {
        switchModel: async () => {},
        instructions: { entry: { put: async () => {} } },
        prompt: async () => {},
        compact: async () => {},
      },
      mcp: { add: async () => {} },
      event: {
        subscribe: async function* ({ signal }: { signal: AbortSignal }) {
          signal.addEventListener(
            "abort",
            () => {
              state.aborted = true;
            },
            { once: true },
          );
          yield {
            type: "session.text.ended",
            data: {
              sessionID: "session",
              assistantMessageID: "reply",
              ordinal: 0,
              text: "Hello",
            },
          };
          yield {
            type: "session.step.ended",
            data: {
              sessionID: "other",
              tokens: {
                input: 999999,
                output: 999999,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
          };
          yield {
            type: "session.usage.updated",
            data: {
              sessionID: "session",
              cost: 0,
              tokens: {
                input: 999999,
                output: 999999,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
          };
          yield {
            type: "session.step.ended",
            data: {
              sessionID: "session",
              tokens: {
                input: 100,
                output: 20,
                reasoning: 5,
                cache: { read: 30, write: 10 },
              },
            },
          };
          yield {
            type: state.failed ? "session.step.failed" : "session.step.ended",
            data: {
              sessionID: "session",
              tokens: {
                input: 200,
                output: 40,
                reasoning: 10,
                cache: { read: 60, write: 20 },
              },
            },
          };
          yield {
            type: state.failed
              ? "session.execution.failed"
              : "session.execution.succeeded",
            data: { sessionID: "session", error: state.error },
          };

          if (!signal.aborted)
            await new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true }),
            );
        },
      },
    }),
  },
}));

it.each([
  {
    failed: false,
    error: undefined,
    modelFailure: false,
    inputLimit: 160000,
    operation: undefined,
    maxTokens: 160000,
  },
  {
    failed: false,
    error: undefined,
    modelFailure: false,
    inputLimit: undefined,
    operation: "compact" as const,
    maxTokens: 200000,
  },
  {
    failed: false,
    error: undefined,
    modelFailure: true,
    inputLimit: undefined,
    operation: undefined,
    maxTokens: null,
  },
  {
    failed: true,
    error: undefined,
    modelFailure: false,
    inputLimit: 160000,
    operation: undefined,
    maxTokens: 160000,
  },
  {
    failed: true,
    error: {
      type: "provider.free-limit",
      status: 429,
      message: "private provider diagnostic",
      response: { body: "private response" },
    },
    modelFailure: false,
    inputLimit: 160000,
    operation: undefined,
    maxTokens: 160000,
  },
])(
  "OpenCode 2 reports the last step separately from processed totals and closes on $failed/$modelFailure/$operation",
  async (scenario) => {
    Object.assign(state, scenario, { aborted: false });
    state.close.mockClear();
    const onUsage = vi.fn();
    const onText = vi.fn();
    const signal = AbortSignal.timeout(2000);
    const run = runOpenCodeTurn(
      { command: "fixture", args: [], cwd: "/tmp/codex", signal },
      {
        agentId: "test",
        agentName: "Test",
        nativeThreadId: "session",
        text: "hello",
        ...(scenario.operation ? { operation: scenario.operation } : {}),
        selection: {
          providerId: "opencode",
          modelId: "opencode/deepseek-v4.1-flash-free",
          options: {},
        },
        signal,
        onThread() {},
        onText,
        onMessage() {},
        onUsage,
      },
      { execute: async () => "", deliverSecret: async () => "" },
    );

    if (scenario.failed)
      await expect(run).rejects.toThrow(
        scenario.error ? "free usage limit" : "could not finish",
      );
    else await run;

    expect(onText).toHaveBeenCalledWith("reply:0", "Hello", true);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      usedTokens: 320,
      maxTokens: scenario.maxTokens,
    });
    expect(state.aborted).toBe(true);
    expect(state.close).toHaveBeenCalledOnce();
  },
);
