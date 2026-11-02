import { agentContext } from "./teamContext.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { runCodexTurn } from "@paws/provider-codex";
import { ChatExecutionError, type RunChatTurn } from "@paws/provider-core";
import { withJsonRpc } from "@paws/provider-core/process";
import { leaseCodexRuntime } from "@paws/runtime";
import type { makeProviderService } from "./ProviderService.ts";

const AuthFile = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.String,
    account_id: Schema.String,
  }),
});

export function makeCodexChatRunner(
  root: string,
  providers: Pick<
    ReturnType<typeof makeProviderService>,
    "list" | "environment"
  >,
): RunChatTurn {
  const run: RunChatTurn = async (turn) => {
    const provider = providers
      .list()
      .find((item) => item.config.id === turn.selection.providerId);

    if (!provider || provider.config.driver !== "codex")
      throw new Error("Chat execution is currently available for Codex.");

    const environment = providers.environment(provider.config.id);
    const configuredHome =
      provider.config.homePath ||
      environment.CODEX_HOME ||
      process.env.CODEX_HOME ||
      join(homedir(), ".codex");
    const home = resolve(
      configuredHome.startsWith("~/")
        ? join(homedir(), configuredHome.slice(2))
        : configuredHome,
    );
    const credentials = async () => {
      // The host helper only refreshes native auth; it never receives a user prompt.
      await withJsonRpc(
        {
          command: provider.config.binaryPath || "codex",
          args: [...provider.config.args, "app-server", "--listen", "stdio://"],
          cwd: root,
          env: { ...process.env, ...environment, CODEX_HOME: home },
          signal: AbortSignal.any([turn.signal, AbortSignal.timeout(30_000)]),
        },
        async (rpc) => {
          await rpc.request("initialize", {
            clientInfo: { name: "paws", version: "0.1.0" },
          });
          rpc.notify("initialized");
          await rpc.request("account/read", { refreshToken: true });
        },
      );

      try {
        const auth = Schema.decodeUnknownSync(AuthFile)(
          JSON.parse(await readFile(join(home, "auth.json"), "utf8")),
        );

        return {
          accessToken: auth.tokens.access_token,
          chatgptAccountId: auth.tokens.account_id,
          chatgptPlanType: null,
        };
      } catch {
        throw new Error(
          "Chat requires a Codex ChatGPT sign-in using file-based credentials. Sign in in Providers and retry.",
        );
      }
    };
    const lease = await leaseCodexRuntime(
      root,
      turn.agentId,
      provider.config.binaryPath,
      agentContext(root, turn.agentId).teams.map((team) => team.id),
    );

    try {
      await runCodexTurn(
        {
          command: lease.command,
          args: lease.args,
          cwd: root,
          signal: turn.signal,
          env: { PATH: process.env.PATH },
        },
        turn,
        credentials,
        async (reference) => {
          if (!turn.consumeSecret) throw new Error("Secret is unavailable.");

          return lease.deliverSecret(reference, turn.consumeSecret(reference));
        },
      );
    } finally {
      await lease.dispose();
    }
  };

  return async (turn) => {
    try {
      await run(turn);
    } catch (error) {
      if (
        error instanceof Error &&
        /^(Chat runtime unavailable|Chat requires a Codex|The agent turn did not complete|Codex executable not found|Generated image could not be delivered)/.test(
          error.message,
        )
      )
        throw new ChatExecutionError(error.message);

      throw error;
    }
  };
}
