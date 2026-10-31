import {
  Agent,
  AgentNotFoundError,
  FileCredentialStore,
  type AgentOptions,
} from "@cursor/sdk";
import { z } from "zod";
import {
  ChatExecutionError,
  ChatSessionUnavailableError,
  chatInstructions,
  type ChatTurn,
} from "@paws/provider-core";
import type { ProbeLaunch } from "@paws/provider-core/process";
import {
  chatTools,
  interactionText,
  nativePrompt,
  type ChatToolRuntime,
} from "./chatTools.ts";

// Same SDK lifecycle and model parameter translation as T3's Cursor adapter.
export async function runCursorTurn(
  launch: ProbeLaunch,
  turn: ChatTurn,
  runtime: ChatToolRuntime,
) {
  const saved = await new FileCredentialStore(
    launch.env?.PAWS_CURSOR_AUTH_FILE,
  ).load();
  const apiKey = launch.env?.CURSOR_API_KEY || saved?.apiKey;

  if (!apiKey)
    throw new ChatExecutionError("Sign in to Cursor in Providers first.");

  const tools = chatTools(turn, runtime);
  const options: AgentOptions = {
    apiKey,
    model: {
      id: turn.selection.modelId,
      params: Object.entries(turn.selection.options).map(([id, value]) => ({
        id:
          id === "contextWindow" ? "context" : id === "fastMode" ? "fast" : id,
        value,
      })),
    },
    tools: ["mcp"],
    systemPrompt: chatInstructions(turn.agentName),
    mcpServers: {},
    agents: {},
    local: {
      cwd: launch.cwd,
      settingSources: [],
      customTools: Object.fromEntries(
        tools.map((entry) => [
          entry.name,
          {
            description: entry.description,
            inputSchema: z
              .record(z.string(), z.json())
              .parse(z.toJSONSchema(entry.schema)),
            execute: async (input: unknown) =>
              entry.execute(entry.schema.parse(input)),
          },
        ]),
      ),
    },
  };
  const agent = turn.nativeThreadId
    ? await Agent.resume(turn.nativeThreadId, options).catch((error) => {
        if (error instanceof AgentNotFoundError)
          throw new ChatSessionUnavailableError(
            "Cursor session no longer exists.",
          );

        throw error;
      })
    : await Agent.create(options);
  turn.onThread(agent.agentId);
  let cancel = () => {};

  try {
    let text = "";
    let segment = 0;
    const run = await agent.send(
      turn.operation === "compact"
        ? "/compress"
        : nativePrompt(turn, await interactionText(turn, runtime)),
      {
        onDelta: ({ update }) => {
          if (update.type === "text-delta") {
            text += update.text;
            turn.onText(`text-${segment}`, text);
          } else if (update.type === "tool-call-started" && text) {
            turn.onText(`text-${segment}`, text, true);
            segment += 1;
            text = "";
          }
        },
      },
    );
    cancel = () => {
      void run.cancel().catch(() => {});
    };
    turn.signal.addEventListener("abort", cancel, { once: true });

    if (turn.signal.aborted) cancel();

    turn.onSteer?.(
      run.steer
        ? async (input) => {
            if ("interaction" in input) return "queue";

            return (await run.steer!(input.text)) === "complete_delivered"
              ? "accepted"
              : "queue";
          }
        : null,
    );
    const result = await run.wait();

    if (result.status === "error")
      throw new ChatExecutionError(
        "Cursor could not finish this reply. Check its connection in Providers.",
      );
  } finally {
    turn.onSteer?.(null);
    turn.signal.removeEventListener("abort", cancel);
    agent.close();
  }
}
