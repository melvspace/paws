import { memoryTool } from "./teamContext.ts";
import { teamTool } from "./teamIntegrations.ts";
import { makeNativeChatRunner } from "./nativeChatRunner.ts";
import type { ProviderDriver } from "@paws/contracts";
import { ChatExecutionError, type RunChatTurn } from "@paws/provider-core";
import type { makeProviderService } from "./ProviderService.ts";
import { makeCodexChatRunner } from "./codexChatRunner.ts";

// Register execution adapters independently of discovery and orchestration.
export function makeChatRunner(
  root: string,
  providers: Pick<
    ReturnType<typeof makeProviderService>,
    "list" | "environment"
  >,
  runners: Partial<Record<ProviderDriver, RunChatTurn>> = {
    codex: makeCodexChatRunner(root, providers),
    claudeAgent: makeNativeChatRunner(root, providers, "claudeAgent"),
    cursor: makeNativeChatRunner(root, providers, "cursor"),
    opencode: makeNativeChatRunner(root, providers, "opencode"),
    pi: makeNativeChatRunner(root, providers, "pi"),
    muse: makeNativeChatRunner(root, providers, "muse"),
    grok: makeNativeChatRunner(root, providers, "grok"),
    fx: makeNativeChatRunner(root, providers, "fx"),
    antigravity: makeNativeChatRunner(root, providers, "antigravity"),
    acpRegistry: makeNativeChatRunner(root, providers, "acpRegistry"),
  },
): RunChatTurn {
  return async (turn) => {
    const provider = providers
      .list()
      .find((item) => item.config.id === turn.selection.providerId);
    const run = provider && runners[provider.config.driver];

    if (!run)
      throw new ChatExecutionError(
        "Chat runtime unavailable for this provider.",
      );

    const privateInputs = new Map<string, string>();
    const consumeSecret = (reference: string): string => {
      const key =
        reference === "saved" ? turn.interaction?.secretRef : reference;

      if (!key) throw new Error("No private input is available for this turn.");

      const cached = privateInputs.get(key);

      if (cached !== undefined) return cached;
      if (!turn.consumeSecret) throw new Error("Private input is unavailable.");

      const value = turn.consumeSecret(key);
      privateInputs.set(key, value);

      return value;
    };

    try {
      await run({
        ...turn,
        ...(turn.consumeSecret ? { consumeSecret } : {}),
        memoryTool: async (input) => memoryTool(root, turn.agentId, input),
        teamTool: (input) =>
          teamTool(root, turn.agentId, input, turn.signal, consumeSecret),
      });
    } finally {
      privateInputs.clear();
    }
  };
}
