import { Schema } from "effect";
import type { ContextUsage } from "@paws/contracts";

export const CodexUsage = Schema.Struct({
  last: Schema.Struct({ totalTokens: Schema.Number }),
  total: Schema.Struct({ totalTokens: Schema.Number }),
  modelContextWindow: Schema.NullOr(Schema.Number),
});

// T3 Code uses the last model request, not cumulative processed tokens, for context.
export function codexContextUsage(value: typeof CodexUsage.Type): ContextUsage {
  const nonnegative = (number: number) => {
    if (!Number.isFinite(number)) throw new Error("Invalid token usage.");

    return Math.max(0, number);
  };
  const max = value.modelContextWindow;

  return {
    usedTokens: nonnegative(value.last.totalTokens),
    maxTokens: max === null || max <= 0 ? null : nonnegative(max),
    totalProcessedTokens: nonnegative(value.total.totalTokens),
  };
}
