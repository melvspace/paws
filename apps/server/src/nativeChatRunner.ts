import type { ProviderDriver } from "@paws/contracts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  runClaudeTurn,
  runCursorTurn,
  runOpenCodeTurn,
  runPiTurn,
  runAcpTurn,
  runMuseTurn,
  providerLaunch,
} from "@paws/provider-native";
import { ChatExecutionError, type RunChatTurn } from "@paws/provider-core";
import { leaseToolRuntime } from "@paws/runtime";
import type { makeProviderService } from "./ProviderService.ts";
import { guardChatTools } from "./chatToolGuard.ts";

export function makeNativeChatRunner(
  root: string,
  providers: Pick<
    ReturnType<typeof makeProviderService>,
    "list" | "environment"
  >,
  driver: Exclude<ProviderDriver, "codex">,
): RunChatTurn {
  return async (turn) => {
    const guarded = guardChatTools(turn);
    const provider = providers
      .list()
      .find((item) => item.config.id === turn.selection.providerId);

    if (!provider || provider.config.driver !== driver)
      throw new ChatExecutionError("The selected provider is unavailable.");

    // Private provider metadata stays outside all agent-readable mounts.
    const control = join(
      root,
      "provider-sessions",
      turn.agentId,
      provider.config.id,
    );
    await mkdir(control, { recursive: true, mode: 0o700 });
    const lease = await leaseToolRuntime(root, turn.agentId).catch(() => {
      throw new ChatExecutionError(
        "Chat runtime unavailable. Run pnpm runtime:build with Docker running.",
      );
    });

    try {
      const execute: (
        launch: Parameters<typeof runClaudeTurn>[0],
        input: Parameters<typeof runClaudeTurn>[1],
        tools: Parameters<typeof runClaudeTurn>[2],
      ) => Promise<void> =
        driver === "claudeAgent"
          ? runClaudeTurn
          : driver === "cursor"
            ? runCursorTurn
            : driver === "pi"
              ? runPiTurn
              : driver === "muse"
                ? runMuseTurn
                : driver === "opencode"
                  ? runOpenCodeTurn
                  : (launch, input, tools) =>
                      runAcpTurn(launch, input, tools, driver);
      await execute(
        providerLaunch(provider.config, control, guarded.signal, {
          ...providers.environment(provider.config.id),
          ...(driver === "cursor"
            ? { PAWS_CURSOR_AUTH_FILE: join(root, "cursor-auth.json") }
            : {}),
        }),
        guarded,
        {
          execute: lease.execute,
          deliverSecret: async (reference) => {
            if (!turn.consumeSecret) throw new Error("Secret unavailable.");

            return lease.deliverSecret(
              reference,
              turn.consumeSecret(reference),
            );
          },
        },
      );
    } catch (error) {
      if (guarded.signal.reason instanceof ChatExecutionError)
        throw guarded.signal.reason;

      throw error;
    } finally {
      await lease.dispose();
    }
  };
}
