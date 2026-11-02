import { expect, it } from "vite-plus/test";
import type { ChatTurn } from "@paws/provider-core";
import { serializeAgentExecution } from "./agentExecution.ts";

it("cancels queued work promptly without releasing a predecessor’s agent lock", async () => {
  let finish = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const execute = serializeAgentExecution(async (turn) => {
    calls.push(turn.text);

    if (turn.text === "first") await held;
  });
  const turn = (
    text: string,
    signal = new AbortController().signal,
  ): ChatTurn => ({
    agentId: "agent",
    agentName: "Ada",
    nativeThreadId: null,
    text,
    signal,
    selection: { providerId: "provider", modelId: "model", options: {} },
    onThread() {},
    onText() {},
    onMessage() {},
  });
  const first = execute(turn("first"));
  const abort = new AbortController();
  const second = execute(turn("second", abort.signal));
  abort.abort(new Error("cancelled"));
  await expect(second).rejects.toThrow("cancelled");
  const third = execute(turn("third"));
  await Promise.resolve();
  expect(calls).toEqual(["first"]);
  finish();
  await Promise.all([first, third]);
  expect(calls).toEqual(["first", "third"]);
});
