import { agentContext } from "./teamContext.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { createCodexChatSession } from "@paws/provider-codex";
import { ChatExecutionError, type RunChatTurn } from "@paws/provider-core";
import { withJsonRpc } from "@paws/provider-core/process";
import { leaseCodexRuntime, ContainerRuntimeError } from "@paws/runtime";
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
) {
  const sessions = new Map<
    string,
    {
      agentId: string;
      signature: string;
      threadId: string | null;
      session: ReturnType<typeof createCodexChatSession>;
      lease: Awaited<ReturnType<typeof leaseCodexRuntime>>;
    }
  >();

  async function closeSession(key: string) {
    const entry = sessions.get(key);

    if (!entry) return;

    sessions.delete(key);
    await entry.session.close();
    await entry.lease.dispose();
  }

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
    const context = agentContext(root, turn.agentId);
    const key = JSON.stringify([
      turn.agentId,
      turn.conversationId ?? turn.agentId,
    ]);
    const signature = JSON.stringify([
      provider.config,
      environment,
      home,
      context.teamId,
      context.sandbox,
      context.template,
    ]);
    let entry = sessions.get(key);

    if (
      entry &&
      (entry.session.closed ||
        entry.signature !== signature ||
        entry.threadId !== turn.nativeThreadId)
    ) {
      await closeSession(key);
      entry = undefined;
    }

    if (!entry) {
      const lease = await leaseCodexRuntime(
        root,
        turn.agentId,
        provider.config.binaryPath,
        context,
      );
      const session = createCodexChatSession({
        command: lease.command,
        args: lease.args,
        cwd: lease.isolation === "container" ? root : lease.workspace,
        signal: new AbortController().signal,
        env: {
          PATH: process.env.PATH,
          HOME: lease.home,
          CODEX_HOME: `${lease.home}/.codex`,
        },
      });
      entry = {
        agentId: turn.agentId,
        signature,
        threadId: turn.nativeThreadId,
        session,
        lease,
      };
      sessions.set(key, entry);
    }

    const active = entry;
    let waiting = false;

    try {
      await active.session.run(
        {
          ...turn,
          workspace: active.lease.workspace,
          home: active.lease.home,
          async onMessage(id, card, attachments) {
            await turn.onMessage(id, card, attachments);
            waiting ||= Boolean(
              card.secretRequest || card.actions.length || card.fields.length,
            );
          },
          onThread(id) {
            active.threadId = id;
            turn.onThread(id);
          },
        },
        credentials,
        async (reference) => {
          if (!turn.consumeSecret) throw new Error("Secret is unavailable.");

          return active.lease.deliverSecret(
            reference,
            turn.consumeSecret(reference),
          );
        },
      );

      // Completed routine runs have no next turn; retain only those awaiting input.
      if (
        turn.conversationId &&
        turn.conversationId !== turn.agentId &&
        !waiting
      )
        await closeSession(key);
    } catch (error) {
      await closeSession(key);

      throw error;
    } finally {
      await active.lease.cleanupSecrets();
    }
  };

  const execute: RunChatTurn = async (turn) => {
    try {
      await run(turn);
    } catch (error) {
      if (error instanceof ContainerRuntimeError)
        throw new ChatExecutionError(error.message);

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

  return Object.assign(execute, {
    async closeAgent(agentId: string) {
      for (const [key, entry] of sessions) {
        if (entry.agentId === agentId) await closeSession(key);
      }
    },
    async close() {
      await Promise.all([...sessions.keys()].map(closeSession));
    },
  });
}
