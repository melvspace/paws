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

    await run(turn);
  };
}
