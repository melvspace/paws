// Context translations adapted from T3 Code provider adapters (MIT).
import { z } from "zod";
import type { ContextUsage } from "@paws/contracts";

const count = z.number().int().nonnegative();

export function acpContextUsage(value: unknown): ContextUsage | undefined {
  const update = z
    .discriminatedUnion("sessionUpdate", [
      z.object({
        sessionUpdate: z.literal("usage_update"),
        used: count,
        size: count,
      }),
      z.object({
        sessionUpdate: z.literal("state_update"),
        state: z.literal("idle"),
        usage: z.object({ totalTokens: count }),
      }),
    ])
    .safeParse(value);

  if (!update.success) return;

  return update.data.sessionUpdate === "usage_update"
    ? {
        usedTokens: update.data.used,
        maxTokens: update.data.size > 0 ? update.data.size : null,
      }
    : { usedTokens: update.data.usage.totalTokens, maxTokens: null };
}

export function museContextUsage(value: unknown): ContextUsage {
  const usage = z
    .object({ usedTokens: count, windowTokens: count.positive().optional() })
    .parse(value);

  return {
    usedTokens: usage.usedTokens,
    maxTokens: usage.windowTokens ?? null,
  };
}

export function piModelContextWindow(value: unknown): number | undefined {
  const model = z.object({ contextWindow: count.positive() }).safeParse(value);

  return model.success ? model.data.contextWindow : undefined;
}

export function piLiveContextUsage(
  value: unknown,
  maxTokens: number | undefined,
): ContextUsage | undefined {
  const message = z
    .object({
      message: z.object({
        role: z.literal("assistant"),
        usage: z.object({ totalTokens: count.positive() }),
      }),
    })
    .safeParse(value);

  if (!message.success || !maxTokens) return;

  return { usedTokens: message.data.message.usage.totalTokens, maxTokens };
}

export function piStatsContextUsage(
  value: unknown,
  fallbackUsedTokens?: number,
): ContextUsage | undefined {
  const stats = z
    .object({
      contextUsage: z.object({
        tokens: count.nullish(),
        contextWindow: count.positive(),
      }),
    })
    .safeParse(value);

  if (!stats.success) return;

  const usedTokens = stats.data.contextUsage.tokens ?? fallbackUsedTokens;

  if (usedTokens === undefined) return;

  return { usedTokens, maxTokens: stats.data.contextUsage.contextWindow };
}
