import { expect, it } from "vite-plus/test";
import { codexContextUsage } from "./contextUsage.ts";

it("uses current context rather than cumulative usage and handles unknown limits", () => {
  expect(
    codexContextUsage({
      last: { totalTokens: 196000 },
      total: { totalTokens: 1900000 },
      modelContextWindow: 258000,
    }),
  ).toEqual({
    usedTokens: 196000,
    totalProcessedTokens: 1900000,
    maxTokens: 258000,
  });
  expect(
    codexContextUsage({
      last: { totalTokens: -1 },
      total: { totalTokens: 0 },
      modelContextWindow: 0,
    }),
  ).toEqual({ usedTokens: 0, totalProcessedTokens: 0, maxTokens: null });
});
