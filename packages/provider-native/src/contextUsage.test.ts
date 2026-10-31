import { expect, it } from "vite-plus/test";
import {
  acpContextUsage,
  museContextUsage,
  piLiveContextUsage,
  piModelContextWindow,
  piStatsContextUsage,
} from "./contextUsage.ts";

it("ACP uses explicit context occupancy and allows an unknown capacity", () => {
  expect(
    acpContextUsage({ sessionUpdate: "usage_update", used: 0, size: 0 }),
  ).toEqual({ usedTokens: 0, maxTokens: null });
  expect(
    acpContextUsage({
      sessionUpdate: "state_update",
      state: "idle",
      usage: { totalTokens: 1200 },
    }),
  ).toEqual({ usedTokens: 1200, maxTokens: null });
});

it.each([
  { sessionUpdate: "usage_update", cost: { amount: 1 } },
  { sessionUpdate: "usage_update", used: -1, size: 200000 },
  { sessionUpdate: "usage_update", used: Infinity, size: 200000 },
  { sessionUpdate: "usage_update", used: 1, size: "200000" },
  {
    sessionUpdate: "state_update",
    state: "running",
    usage: { totalTokens: 1200 },
  },
  { sessionUpdate: "state_update", state: "idle", usage: null },
])("ignores malformed or non-measurement ACP updates: %j", (update) => {
  expect(acpContextUsage(update)).toBeUndefined();
});

it("Muse preserves reported occupancy without fabricating a window or cumulative total", () => {
  expect(museContextUsage({ usedTokens: 1200 })).toEqual({
    usedTokens: 1200,
    maxTokens: null,
  });
  expect(() =>
    museContextUsage({ usedTokens: -1, windowTokens: 200000 }),
  ).toThrow();
});

it("Pi requires a known model capacity for streaming context and ignores non-assistant messages", () => {
  const value = {
    message: { role: "assistant", usage: { totalTokens: 1200 } },
  };
  expect(piModelContextWindow({ contextWindow: 200000 })).toBe(200000);
  expect(piModelContextWindow({ contextWindow: 0 })).toBeUndefined();
  expect(piLiveContextUsage(value, undefined)).toBeUndefined();
  expect(piLiveContextUsage(value, 200000)).toEqual({
    usedTokens: 1200,
    maxTokens: 200000,
  });
  expect(
    piLiveContextUsage(
      { message: { role: "toolResult", usage: { totalTokens: 999 } } },
      200000,
    ),
  ).toBeUndefined();
});

it("Pi session stats use current context rather than cumulative token totals and support compaction fallback", () => {
  expect(
    piStatsContextUsage({
      contextUsage: { tokens: 1200, contextWindow: 200000 },
      tokens: { input: 999999, output: 999999 },
    }),
  ).toEqual({ usedTokens: 1200, maxTokens: 200000 });
  expect(
    piStatsContextUsage(
      { contextUsage: { tokens: null, contextWindow: 200000 } },
      400,
    ),
  ).toEqual({ usedTokens: 400, maxTokens: 200000 });
  expect(
    piStatsContextUsage(
      { contextUsage: { tokens: 0, contextWindow: 200000 } },
      400,
    ),
  ).toEqual({ usedTokens: 0, maxTokens: 200000 });
  expect(piStatsContextUsage({ tokens: { total: 999999 } })).toBeUndefined();
  expect(
    piStatsContextUsage({
      contextUsage: { tokens: null, contextWindow: 200000 },
    }),
  ).toBeUndefined();
  expect(
    piStatsContextUsage({ contextUsage: { tokens: 1200, contextWindow: 0 } }),
  ).toBeUndefined();
});
