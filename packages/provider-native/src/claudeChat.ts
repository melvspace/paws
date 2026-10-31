import { chatTools, type ChatToolRuntime } from "./chatTools.ts";
import {
  query,
  createSdkMcpServer,
  tool,
  type SDKUserMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  chatInstructions,
  ChatExecutionError,
  type ChatTurn,
} from "@paws/provider-core";
import type { ProbeLaunch } from "@paws/provider-core/process";

type ClaudeSession = Pick<
  ReturnType<typeof query>,
  "close" | "getContextUsage"
> &
  AsyncIterable<SDKMessage>;
type StartClaudeQuery = (input: Parameters<typeof query>[0]) => ClaudeSession;

// Match T3's SDK session lifecycle; every executable capability is supplied by the runtime.
export async function runClaudeTurn(
  launch: ProbeLaunch,
  turn: ChatTurn,
  runtime: ChatToolRuntime,
  startQuery: StartClaudeQuery = query,
) {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  turn.signal.addEventListener("abort", abort, { once: true });

  if (turn.signal.aborted) abort();

  const server = createSdkMcpServer({
    name: "paws",
    version: "1.0.0",
    tools: chatTools(turn, runtime).map((entry) =>
      tool(entry.name, entry.description, entry.schema.shape, async (input) =>
        entry.execute(entry.schema.parse(input)),
      ),
    ),
  });
  const allowedTools = [
    "paws_exec",
    "paws_send_message",
    "paws_finish_turn",
    "request_secret",
    "paws_read_attachment",
    "paws_view_image",
  ].map((name) => `mcp__paws__${name}`);
  const effort = turn.selection.options.effort;
  const validEffort =
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
      ? effort
      : undefined;
  const prompt: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      if (turn.handoff) {
        yield {
          type: "user",
          parent_tool_use_id: null,
          message: { role: "user", content: turn.handoff },
          isSynthetic: true,
          client_composed: true,
          shouldQuery: false,
        };
      }

      let interaction: unknown = turn.interaction;

      if (turn.interaction?.secretRef) {
        const { secretRef, ...event } = turn.interaction;
        interaction = {
          ...event,
          file: await runtime.deliverSecret(secretRef),
        };
      }

      yield {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content:
            turn.operation === "compact"
              ? "/compact"
              : turn.interaction
                ? `Paws harness UI event (not user-authored text):\n${JSON.stringify(interaction)}`
                : turn.text,
        },
        ...(turn.interaction ? { isSynthetic: true } : {}),
        // Prevent host @file expansion and slash dispatch for all user-supplied content.
        ...(turn.operation !== "compact"
          ? { client_composed: true as const }
          : {}),
      };
    },
  };
  let session: ClaudeSession | undefined;

  try {
    session = startQuery({
      prompt,
      options: {
        pathToClaudeCodeExecutable: launch.command,
        abortController,
        cwd: launch.cwd,
        ...(turn.nativeThreadId ? { resume: turn.nativeThreadId } : {}),
        model: turn.selection.modelId,
        ...(validEffort ? { effort: validEffort } : {}),
        systemPrompt: chatInstructions(turn.agentName),
        settingSources: [],
        settings: {
          disableAllHooks: true,
          fastMode: turn.selection.options.fastMode === "true",
        },
        tools: [],
        allowedTools,
        canUseTool: async (name, input) =>
          allowedTools.includes(name)
            ? { behavior: "allow", updatedInput: input }
            : {
                behavior: "deny",
                message: "Use only the Paws container tools.",
              },
        mcpServers: { paws: server },
        strictMcpConfig: true,
        plugins: [],
        env: {
          ...(launch.env ?? process.env),
          ENABLE_CLAUDEAI_MCP_SERVERS: "false",
          CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
          CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        },
        stderr: () => {},
      },
    });
    let completed = false;

    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init")
        turn.onThread(message.session_id);

      if (message.type === "assistant" && !message.parent_tool_use_id) {
        if (message.error === "verification_required")
          throw new ChatExecutionError(
            "Claude requires identity verification. Complete verification with Anthropic, then retry.",
          );
        if (message.error)
          throw new ChatExecutionError(
            "Claude could not process this request. Check its account and model in Providers.",
          );

        const text = message.message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n\n");

        if (text) turn.onText(message.uuid, text, true);
      }

      if (message.type === "result") {
        if (message.is_error || message.subtype !== "success")
          throw new ChatExecutionError(
            "Claude could not finish this reply. Check its connection in Providers and retry.",
          );

        completed = true;
        const context = await session.getContextUsage().catch(() => null);

        if (context) {
          turn.onUsage?.({
            usedTokens: context.totalTokens,
            maxTokens: context.rawMaxTokens,
            totalProcessedTokens: Object.values(message.modelUsage).reduce(
              (total, usage) =>
                total +
                usage.inputTokens +
                usage.outputTokens +
                usage.cacheReadInputTokens +
                usage.cacheCreationInputTokens,
              0,
            ),
          });
        }

        break;
      }
    }

    if (!completed && !turn.signal.aborted)
      throw new ChatExecutionError(
        "Claude ended before completing the reply. Try again.",
      );
  } finally {
    turn.onSteer?.(null);
    turn.signal.removeEventListener("abort", abort);
    abort();
    session?.close();
  }
}
