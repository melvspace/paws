import { randomUUID } from "node:crypto";
import { writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  chatInstructions,
  ChatExecutionError,
  ChatSessionUnavailableError,
  type ChatTurn,
} from "@paws/provider-core";
import { withJsonRpc, type ProbeLaunch } from "@paws/provider-core/process";
import { openToolBridge } from "./toolBridge.ts";
import {
  piLiveContextUsage,
  piModelContextWindow,
  piStatsContextUsage,
} from "./contextUsage.ts";
import {
  interactionText,
  nativePrompt,
  type ChatToolRuntime,
} from "./chatTools.ts";

// T3 uses Pi's JSON-line RPC protocol. Explicit extensions remain enabled with --no-extensions.
export async function runPiTurn(
  launch: ProbeLaunch,
  turn: ChatTurn,
  runtime: ChatToolRuntime,
) {
  const extension = join(launch.cwd, `paws-tools-${randomUUID()}.mjs`);
  const id = turn.nativeThreadId ?? randomUUID();

  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid Pi session ID");

  const bridge = await openToolBridge(turn, runtime);

  try {
    if (turn.nativeThreadId) {
      await access(join(launch.cwd, `${id}.jsonl`)).catch(() => {
        throw new ChatSessionUnavailableError("Pi session no longer exists.");
      });
    }

    await writeFile(
      extension,
      `export default function(pi) {
      for (const definition of ${JSON.stringify(bridge.tools)}) {
        pi.registerTool({ name: definition.name, label: definition.name, description: definition.description, parameters: definition.inputSchema,
          async execute(_id, args, signal) {
            const response = await fetch(${JSON.stringify(bridge.url)}, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: ${JSON.stringify(`Bearer ${bridge.token}`)} }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: definition.name, arguments: args } }) });
            const body = await response.json();
            if (body.error) throw new Error('Paws tool failed');
            return body.result;
          }
        });
      }
    }`,
      { mode: 0o600 },
    );
    await withJsonRpc(
      {
        ...launch,
        args: [
          ...launch.args,
          "--mode",
          "rpc",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--extension",
          extension,
          "--session",
          join(launch.cwd, `${id}.jsonl`),
          "--append-system-prompt",
          chatInstructions(turn.agentName),
        ],
      },
      async (rpc) => {
        const slash = turn.selection.modelId.indexOf("/");
        const selectedModel = await rpc.request("set_model", {
          provider: turn.selection.modelId.slice(0, slash),
          modelId: turn.selection.modelId.slice(slash + 1),
        });
        const contextWindow = piModelContextWindow(selectedModel);

        if (turn.selection.options.thinkingLevel)
          await rpc.request("set_thinking_level", {
            level: turn.selection.options.thinkingLevel,
          });

        turn.onThread(id);
        let complete = () => {};
        let fail = (_error: unknown) => {};
        const done = new Promise<void>((resolve, reject) => {
          complete = resolve;
          fail = reject;
        });
        void done.catch(() => {});
        let text = "";
        let segment = 0;
        let lastLiveUsedTokens: number | undefined;
        let compactedTokens: number | undefined;
        const unsubscribe = rpc.onNotification((method, value) => {
          if (method === "message_update" || method === "message_end") {
            const usage = piLiveContextUsage(value, contextWindow);

            if (usage && usage.usedTokens !== lastLiveUsedTokens) {
              lastLiveUsedTokens = usage.usedTokens;
              turn.onUsage?.(usage);
            }
          }

          if (method === "message_end") {
            if (text) turn.onText(`text-${segment}`, text, true);

            const ended = z
              .object({
                message: z.object({ stopReason: z.string().optional() }),
              })
              .safeParse(value);

            if (ended.success && ended.data.message.stopReason === "error")
              fail(
                new ChatExecutionError(
                  "Pi could not finish this reply. Check its provider connection.",
                ),
              );
          }
          if (method === "agent_end") complete();
          if (method === "message_start") {
            text = "";
            segment += 1;
          }
          if (method !== "message_update") return;

          const event = z
            .object({
              assistantMessageEvent: z.object({
                type: z.string(),
                delta: z.string().optional(),
              }),
            })
            .safeParse(value);

          if (
            event.success &&
            event.data.assistantMessageEvent.type === "text_delta"
          ) {
            text += event.data.assistantMessageEvent.delta ?? "";
            turn.onText(`text-${segment}`, text);
          }
        });

        try {
          if (turn.operation === "compact") {
            const result = await rpc.request("compact");
            const compact = z
              .object({ estimatedTokensAfter: z.number().int().nonnegative() })
              .safeParse(result);
            compactedTokens = compact.success
              ? compact.data.estimatedTokensAfter
              : undefined;
          } else {
            await rpc.request("prompt", {
              message: nativePrompt(turn, await interactionText(turn, runtime)),
            });
            await done;
          }
        } finally {
          if (!turn.signal.aborted) {
            let cancelTimeout = () => {};

            try {
              const stats = await Promise.race([
                rpc.request("get_session_stats"),
                new Promise<undefined>((resolve) => {
                  const timeout = setTimeout(resolve, 2000);
                  cancelTimeout = () => clearTimeout(timeout);
                }),
              ]).catch(() => undefined);
              const usage = piStatsContextUsage(stats, compactedTokens);

              if (usage) turn.onUsage?.(usage);
            } finally {
              cancelTimeout();
            }
          }

          unsubscribe();
        }
      },
      "pi",
    );
  } finally {
    await bridge.close();
    await rm(extension, { force: true });
  }
}
