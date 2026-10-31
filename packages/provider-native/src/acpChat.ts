import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  chatInstructions,
  ChatExecutionError,
  ChatSessionUnavailableError,
  type ChatTurn,
} from "@paws/provider-core";
import {
  withJsonRpc,
  RpcRejectedError,
  type ProbeLaunch,
} from "@paws/provider-core/process";
import { openToolBridge } from "./toolBridge.ts";
import { acpContextUsage } from "./contextUsage.ts";
import {
  interactionText,
  nativePrompt,
  type ChatToolRuntime,
} from "./chatTools.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function containerPath(path: string, control: string) {
  const mapped =
    path === control
      ? "/workspace"
      : path.startsWith(`${control}/`)
        ? `/workspace/${path.slice(control.length + 1)}`
        : path;

  if (
    !["/workspace", "/home/agent"].some(
      (root) => mapped === root || mapped.startsWith(`${root}/`),
    ) ||
    mapped.split("/").includes("..") ||
    mapped.includes("\0")
  )
    throw new Error("Path outside the agent workspace");

  return mapped;
}

// ACP lifecycle shared by Grok, fx, Antigravity and registry agents in T3 Code.
// File and terminal requests are fulfilled in the runtime; native host execution is refused.
export async function runAcpTurn(
  launch: ProbeLaunch,
  turn: ChatTurn,
  runtime: ChatToolRuntime,
  driver: "grok" | "fx" | "antigravity" | "acpRegistry",
) {
  if (turn.operation === "compact")
    throw new ChatExecutionError(
      "This provider manages context automatically; manual compaction is unavailable.",
    );

  const bridge = await openToolBridge(turn, runtime);
  const terminals = new Map<
    string,
    {
      abort: AbortController;
      done: Promise<void>;
      output: string;
      exitCode?: number;
    }
  >();
  const args = [
    ...launch.args,
    ...(driver === "grok"
      ? ["agent", "stdio"]
      : driver === "fx"
        ? ["acp"]
        : []),
  ];

  try {
    await withJsonRpc(
      { ...launch, args },
      async (rpc) => {
        const initialized = z
          .object({
            agentCapabilities: z
              .object({
                loadSession: z.boolean().optional(),
                mcpCapabilities: z
                  .object({ http: z.boolean().optional() })
                  .optional(),
              })
              .optional(),
          })
          .parse(
            await rpc.request("initialize", {
              protocolVersion: 1,
              clientInfo: { name: "paws", version: "1" },
              clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: true,
              },
            }),
          );
        const mcpServers = initialized.agentCapabilities?.mcpCapabilities?.http
          ? [
              {
                type: "http",
                name: "paws",
                url: bridge.url,
                headers: [
                  { name: "Authorization", value: `Bearer ${bridge.token}` },
                ],
              },
            ]
          : [
              {
                name: "paws",
                command: process.execPath,
                args: [
                  fileURLToPath(new URL("./mcpProxy.ts", import.meta.url)),
                ],
                env: [
                  { name: "PAWS_TOOL_URL", value: bridge.url },
                  { name: "PAWS_TOOL_TOKEN", value: bridge.token },
                ],
              },
            ];
        const resume =
          turn.nativeThreadId && initialized.agentCapabilities?.loadSession;

        if (turn.nativeThreadId && !resume)
          throw new ChatSessionUnavailableError(
            "This ACP agent does not support session resume.",
          );

        const state = z
          .object({
            sessionId: z.string().optional(),
            configOptions: z
              .array(
                z.object({ id: z.string(), category: z.string().optional() }),
              )
              .optional(),
          })
          .parse(
            await rpc
              .request(resume ? "session/load" : "session/new", {
                cwd: launch.cwd,
                mcpServers,
                ...(resume ? { sessionId: turn.nativeThreadId } : {}),
              })
              .catch((error) => {
                if (resume && error instanceof RpcRejectedError)
                  throw new ChatSessionUnavailableError(
                    "The ACP session could not be loaded.",
                  );

                throw error;
              }),
          );
        const sessionId = state.sessionId ?? turn.nativeThreadId;

        if (!sessionId) throw new Error("ACP returned no session ID");

        turn.onThread(sessionId);
        const modelConfig = state.configOptions?.find(
          (option) => option.category === "model" || option.id === "model",
        );

        if (modelConfig) {
          await rpc.request("session/set_config_option", {
            sessionId,
            configId: modelConfig.id,
            value: turn.selection.modelId,
          });
        } else {
          await rpc.request("session/set_model", {
            sessionId,
            modelId: turn.selection.modelId,
            ...(driver === "grok" && turn.selection.options.reasoningEffort
              ? {
                  _meta: {
                    reasoningEffort: turn.selection.options.reasoningEffort,
                  },
                }
              : {}),
          });
        }

        for (const [key, value] of Object.entries(turn.selection.options)) {
          const config = state.configOptions?.find(
            (option) => option.id === key,
          );

          if (config)
            await rpc.request("session/set_config_option", {
              sessionId,
              configId: config.id,
              value,
            });
        }

        let text = "";
        let segment = 0;
        const unsubscribe = rpc.onNotification((method, raw) => {
          if (method !== "session/update") return;

          const event = z
            .object({
              sessionId: z.string(),
              update: z.looseObject({
                sessionUpdate: z.string(),
                content: z
                  .object({ type: z.string(), text: z.string().optional() })
                  .optional(),
              }),
            })
            .safeParse(raw);

          if (!event.success || event.data.sessionId !== sessionId) return;

          const usage = acpContextUsage(event.data.update);

          if (usage) turn.onUsage?.(usage);

          if (
            event.data.update.sessionUpdate === "agent_message_chunk" &&
            event.data.update.content?.type === "text"
          ) {
            text += event.data.update.content.text ?? "";
            turn.onText(`text-${segment}`, text);
          } else if (event.data.update.sessionUpdate === "tool_call" && text) {
            turn.onText(`text-${segment}`, text, true);
            text = "";
            segment += 1;
          }
        });

        try {
          const response = z.object({ stopReason: z.string() }).parse(
            await rpc.request("session/prompt", {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text: `${chatInstructions(turn.agentName)}\n\nUse only the Paws MCP tools or client-provided file and terminal operations.\n\n${nativePrompt(turn, await interactionText(turn, runtime))}`,
                },
              ],
            }),
          );

          if (response.stopReason === "refusal")
            throw new ChatExecutionError("The provider declined this request.");
        } finally {
          unsubscribe();
        }
      },
      "jsonrpc",
      async (method, raw) => {
        if (method === "session/request_permission")
          return { outcome: { outcome: "cancelled" } };

        if (method === "fs/read_text_file") {
          const input = z.object({ path: z.string() }).parse(raw);

          return {
            content: await runtime.execute(
              `cat -- ${quote(containerPath(input.path, launch.cwd))}`,
              turn.signal,
            ),
          };
        }

        if (method === "fs/write_text_file") {
          const input = z
            .object({ path: z.string(), content: z.string().max(200000) })
            .parse(raw);
          await runtime.execute(
            `printf %s ${quote(Buffer.from(input.content).toString("base64"))} | base64 -d > ${quote(containerPath(input.path, launch.cwd))}`,
            turn.signal,
          );

          return {};
        }

        if (method === "terminal/create") {
          const input = z
            .object({
              command: z.string(),
              args: z.array(z.string()).optional(),
              cwd: z.string().optional(),
            })
            .parse(raw);
          const id = randomUUID();
          const abort = new AbortController();
          const terminal: {
            abort: AbortController;
            done: Promise<void>;
            output: string;
            exitCode?: number;
          } = { abort, done: Promise.resolve(), output: "" };
          terminal.done = runtime
            .execute(
              `cd ${quote(containerPath(input.cwd ?? launch.cwd, launch.cwd))} && ${[input.command, ...(input.args ?? [])].map(quote).join(" ")}`,
              AbortSignal.any([turn.signal, abort.signal]),
            )
            .then(
              (output) => {
                terminal.output = output;
                terminal.exitCode = 0;
              },
              () => {
                terminal.output = "Command failed or cancelled.";
                terminal.exitCode = 1;
              },
            );
          terminals.set(id, terminal);

          return { terminalId: id };
        }

        const { terminalId } = z.object({ terminalId: z.string() }).parse(raw);
        const terminal = terminals.get(terminalId);

        if (!terminal) throw new Error("Unknown terminal");
        if (method === "terminal/wait_for_exit") {
          await terminal.done;

          return { exitCode: terminal.exitCode };
        }
        if (method === "terminal/output")
          return {
            output: terminal.output,
            truncated: false,
            ...(terminal.exitCode !== undefined
              ? { exitStatus: { exitCode: terminal.exitCode } }
              : {}),
          };
        if (method === "terminal/kill" || method === "terminal/release") {
          terminal.abort.abort();
          await terminal.done;
          terminals.delete(terminalId);

          return {};
        }

        throw new Error("Unsupported ACP client operation");
      },
    );
  } finally {
    for (const terminal of terminals.values()) terminal.abort.abort();
    await Promise.all([...terminals.values()].map((terminal) => terminal.done));
    await bridge.close();
  }
}
