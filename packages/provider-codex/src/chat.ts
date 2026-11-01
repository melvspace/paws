import {
  chatInstructions,
  teamToolDescription,
  ChatSessionUnavailableError,
} from "@paws/provider-core";
// Thread lifecycle and dynamic tool translation follow T3 Code's Codex adapter (MIT).
import { CodexUsage, codexContextUsage } from "./contextUsage.ts";
import { Schema } from "effect";
import { ChatCard, ChatFileInputs, validateChatCard } from "@paws/contracts";
import type { ChatTurn } from "@paws/provider-core";
import {
  RpcRejectedError,
  withJsonRpc,
  type ProbeLaunch,
} from "@paws/provider-core/process";

const UsageNotification = Schema.Struct({
  threadId: Schema.String,
  tokenUsage: CodexUsage,
});
const ThreadResponse = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
});
const TurnResponse = Schema.Struct({
  turn: Schema.Struct({ id: Schema.String }),
});
const StartedTurn = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({ id: Schema.String }),
});
const ToolCall = Schema.Struct({
  threadId: Schema.String,
  callId: Schema.String,
  tool: Schema.String,
  arguments: Schema.Unknown,
});
const CompletedItem = Schema.Struct({
  threadId: Schema.String,
  item: Schema.Struct({
    id: Schema.String,
    type: Schema.String,
    text: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    savedPath: Schema.optional(Schema.NullOr(Schema.String)),
    failure: Schema.optional(Schema.Unknown),
  }),
});
const Delta = Schema.Struct({
  threadId: Schema.String,
  itemId: Schema.String,
  delta: Schema.String,
});
const CompletedTurn = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({
    status: Schema.String,
    id: Schema.optional(Schema.String),
  }),
});
const actionSchema = {
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "string" }, label: { type: "string" } },
  required: ["id", "label"],
};
export const messageTool = {
  type: "function",
  name: "paws_send_message",
  description:
    "Send a short messenger message to the user. Optionally attach media/documents from /workspace, include action buttons or a form. Controls do not execute code. Clicks and submissions arrive later as structured paws_interaction tool results from the Paws harness, not user-authored chat messages. Use distinct short messages, avoid repeating them in your final answer. Stop and wait after asking the user a question. Supply empty arrays when no controls are needed. Forms without actions get a Submit button.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", maxLength: 8000 },
      attachments: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", maxLength: 4096 },
            name: { type: "string", maxLength: 200 },
          },
          required: ["path"],
        },
      },
      actions: { type: "array", maxItems: 6, items: actionSchema },
      fields: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            type: { type: "string", enum: ["text", "textarea", "select"] },
            required: { type: "boolean" },
            choices: { type: "array", maxItems: 20, items: actionSchema },
          },
          required: ["id", "label", "type", "required", "choices"],
        },
      },
    },
    required: ["text", "actions", "fields"],
  },
};

const SecretRequest = Schema.Struct({
  label: Schema.String,
  reason: Schema.String,
});
const finishTurnTool = {
  type: "function",
  name: "paws_finish_turn",
  description:
    "Finish this turn silently when the user does not want a reply. Call with silent: true, then end immediately without an acknowledgement or final message. Applies only to this turn; already delivered messages remain visible.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { silent: { type: "boolean", enum: [true] } },
    required: ["silent"],
  },
};
const memoryTool = {
  type: "function",
  name: "paws_memory",
  description:
    "Read or update persistent memories. Omit teamId for private personal memories; provide teamId for shared team memories. Omit memory to read. Read before updating and provide the full replacement memory, preserving useful existing facts. Never store credentials.",
  inputSchema: {
    type: "object",
    properties: {
      teamId: { type: "string" },
      memory: { type: "string", maxLength: 16000 },
    },
    additionalProperties: false,
  },
};

const teamTool = {
  type: "function",
  name: "paws_team_tool",
  description: teamToolDescription,
  inputSchema: {
    type: "object",
    properties: {
      teamId: { type: "string" },
      action: {
        type: "string",
        enum: ["list", "install", "configure", "tools", "call", "exec"],
      },
      script: { type: "string" },
      integrationId: { type: "string" },
      integration: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["cli", "mcp-stdio", "mcp-http"] },
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          url: { type: "string" },
        },
        required: ["id", "kind"],
        additionalProperties: false,
      },
      tool: { type: "string" },
      arguments: { type: "object", additionalProperties: true },
      args: { type: "array", items: { type: "string" } },
      secrets: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["teamId", "action"],
    additionalProperties: false,
  },
};

const readAttachmentTool = {
  type: "function",
  name: "paws_read_attachment",
  description:
    "Resolve a conversation attachment id to a local workspace path and file metadata. Then use your harness tools to inspect or process that file. This tool does not interpret media.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};

const secretTool = {
  type: "function",
  name: "request_secret",
  description:
    "Ask for an API key, token, or password in a private Paws card. Never ask the user to paste secrets into chat. The user may save or decline. Stop and wait; a later paws_interaction tool result provides a temporary private file path, never the value. Read the file only inside the command that needs it; never print or copy the secret. The file is deleted when that turn ends.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { label: { type: "string" }, reason: { type: "string" } },
    required: ["label", "reason"],
  },
};

function secretCard(label: string, reason: string) {
  return validateChatCard({
    text: reason,
    actions: [],
    fields: [],
    secretRequest: { label },
  });
}

export interface ChatCredentials {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
}

export async function runCodexTurn(
  launch: ProbeLaunch,
  turn: ChatTurn,
  credentials: () => Promise<ChatCredentials>,
  deliverSecret?: (reference: string) => Promise<string>,
) {
  let threadId = turn.nativeThreadId;
  const text = new Map<string, string>();
  const images = new Map<string, Promise<void>>();
  const runningImages = new Set<string>();
  let turnCompleted = false;
  let activeTurnId: string | null = null;
  let steering = 0;
  const completedTurns = new Set<string>();
  let resolveCompletion: () => void = () => {};
  let rejectCompletion: (error: Error) => void = () => {};
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Notifications can arrive before the turn/start response.
  void completion.catch(() => {});

  function finishWhenReady() {
    if (turnCompleted && runningImages.size === 0 && steering === 0)
      resolveCompletion();
  }

  await withJsonRpc(
    { ...launch, maxFrameBytes: 32 * 1024 * 1024 },
    async (rpc) => {
      await rpc.request("initialize", {
        clientInfo: { name: "paws", title: "Paws", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
      // External tokens are held by the harness in memory, never mounted or passed in env/argv.
      await rpc.request("account/login/start", {
        type: "chatgptAuthTokens",
        ...(await credentials()),
      });
      const runtime = {
        cwd: "/workspace",
        model: turn.selection.modelId,
        approvalPolicy: "never",
        sandbox: "danger-full-access", // The enclosing container is the execution boundary.
        serviceTier: turn.selection.options.serviceTier ?? "default",
        developerInstructions: chatInstructions(turn.agentName),
        config: {
          "features.multi_agent": false,
          "features.plugins": false,
          "features.in_app_chat": false,
        },
      };
      const started = Schema.decodeUnknownSync(ThreadResponse)(
        await rpc
          .request(threadId ? "thread/resume" : "thread/start", {
            ...runtime,
            ...(threadId
              ? { threadId }
              : {
                  dynamicTools: [
                    messageTool,
                    secretTool,
                    readAttachmentTool,
                    teamTool,
                    memoryTool,
                    finishTurnTool,
                  ],
                }),
          })
          .catch((error) => {
            if (threadId && error instanceof RpcRejectedError)
              throw new ChatSessionUnavailableError(
                "The native thread could not be resumed.",
              );

            throw error;
          }),
      );
      threadId = started.thread.id;
      turn.onThread(threadId);
      const unsubscribe = rpc.onNotification((method, params) => {
        try {
          if (method === "turn/started") {
            const event = Schema.decodeUnknownSync(StartedTurn)(params);

            if (event.threadId === threadId) {
              activeTurnId = event.turn.id;
              turnCompleted = false;
            }
          } else if (method === "thread/tokenUsage/updated") {
            const event = Schema.decodeUnknownSync(UsageNotification)(params);

            if (event.threadId === threadId)
              turn.onUsage?.(codexContextUsage(event.tokenUsage));
          } else if (method === "item/agentMessage/delta") {
            const item = Schema.decodeUnknownSync(Delta)(params);

            if (item.threadId !== threadId) return;

            const value = (text.get(item.itemId) ?? "") + item.delta;
            text.set(item.itemId, value);
            turn.onText(item.itemId, value);
          } else if (method === "item/started") {
            const item = Schema.decodeUnknownSync(CompletedItem)(params);

            if (
              item.threadId === threadId &&
              item.item.type === "imageGeneration"
            )
              runningImages.add(item.item.id);
          } else if (method === "item/completed") {
            const item = Schema.decodeUnknownSync(CompletedItem)(params);

            if (
              item.threadId === threadId &&
              item.item.type === "imageGeneration"
            ) {
              if (
                item.item.status !== "completed" ||
                item.item.failure ||
                !item.item.savedPath
              ) {
                rejectCompletion(
                  new Error(
                    "Generated image could not be delivered. Please try again.",
                  ),
                );
              } else if (!images.has(item.item.id)) {
                runningImages.add(item.item.id);
                const save = turn.onImage
                  ? turn.onImage(item.item.id, item.item.savedPath)
                  : Promise.reject(
                      new Error(
                        "Generated image could not be delivered. Please try again.",
                      ),
                    );
                images.set(item.item.id, save);
                void save.then(
                  () => {
                    runningImages.delete(item.item.id);
                    finishWhenReady();
                  },
                  () =>
                    rejectCompletion(
                      new Error(
                        "Generated image could not be delivered. Please try again.",
                      ),
                    ),
                );
              }
            }

            if (
              item.threadId === threadId &&
              item.item.type === "agentMessage" &&
              item.item.text
            ) {
              turn.onText(item.item.id, item.item.text, true);
            }
          } else if (method === "turn/completed") {
            const done = Schema.decodeUnknownSync(CompletedTurn)(params);

            if (done.threadId !== threadId) return;
            if (done.turn.id) completedTurns.add(done.turn.id);
            if (done.turn.id && activeTurnId && done.turn.id !== activeTurnId)
              return;
            turn.onSteer?.(null);
            if (done.turn.status === "completed") {
              turnCompleted = true;
              finishWhenReady();
            } else
              rejectCompletion(
                new Error(
                  "The agent turn did not complete. Try sending again.",
                ),
              );
          }
        } catch {
          rejectCompletion(
            new Error("The provider sent an invalid chat event."),
          );
        }
      });

      if (turn.operation !== "compact")
        turn.onSteer?.(async (input) => {
          const interaction =
            "interaction" in input ? input.interaction : undefined;
          // Secret files belong to the consuming turn; queue them without spending their reference.
          if (
            !activeTurnId ||
            turnCompleted ||
            turn.signal.aborted ||
            interaction?.secretRef
          )
            return "queue";

          steering += 1;

          try {
            if ("text" in input) {
              await rpc.request("turn/steer", {
                threadId,
                expectedTurnId: activeTurnId,
                clientUserMessageId: input.requestId,
                input: [{ type: "text", text: input.text, text_elements: [] }],
              });

              return "accepted";
            }
            // turn/start's toolOutput steers an active turn without inventing a user message.
            // Unlike turn/steer's text input, this preserves the interaction's tool-result role.
            const response = Schema.decodeUnknownSync(TurnResponse)(
              await rpc.request("turn/start", {
                threadId,
                input: [],
                turnTrigger: "paws_interaction",
                toolOutput: {
                  name: "paws_interaction",
                  namespace: null,
                  output: JSON.stringify(interaction),
                  retain: true,
                },
              }),
            );

            if (response.turn.id !== activeTurnId) {
              activeTurnId = response.turn.id;
              turnCompleted = completedTurns.has(activeTurnId);
            }

            return "accepted";
          } catch (error) {
            if (error instanceof RpcRejectedError) return "queue";

            throw error;
          } finally {
            steering -= 1;
            finishWhenReady();
          }
        });

      try {
        if (turn.operation === "compact") {
          await rpc.request("thread/compact/start", { threadId });
        } else {
          let interaction: unknown = turn.interaction;

          if (turn.interaction?.secretRef) {
            if (!deliverSecret)
              throw new Error("Secret delivery is unavailable.");

            const { secretRef, ...event } = turn.interaction;
            interaction = { ...event, file: await deliverSecret(secretRef) };
          }

          const response = await rpc.request("turn/start", {
            threadId,
            model: turn.selection.modelId,
            ...(turn.handoff
              ? {
                  additionalContext: {
                    paws_handoff: { kind: "untrusted", value: turn.handoff },
                  },
                }
              : {}),
            input: turn.interaction
              ? []
              : [{ type: "text", text: turn.text, text_elements: [] }],
            ...(turn.interaction
              ? {
                  turnTrigger: "paws_interaction",
                  toolOutput: {
                    name: "paws_interaction",
                    namespace: null,
                    output: JSON.stringify(interaction),
                    retain: true,
                  },
                }
              : {}),
            ...(turn.selection.options.reasoningEffort
              ? { effort: turn.selection.options.reasoningEffort }
              : {}),
            serviceTier: turn.selection.options.serviceTier ?? "default",
          });
          activeTurnId ??=
            Schema.decodeUnknownSync(TurnResponse)(response).turn.id;
        }

        await completion;
        await Promise.all(images.values());
      } finally {
        turn.onSteer?.(null);
        unsubscribe();
      }
    },
    "jsonrpc",
    async (method, params) => {
      if (method === "account/chatgptAuthTokens/refresh") return credentials();
      if (method !== "item/tool/call")
        throw new Error("Unsupported tool request.");

      const call = Schema.decodeUnknownSync(ToolCall)(params);

      if (
        call.threadId !== threadId ||
        ![
          "paws_send_message",
          "request_secret",
          "paws_read_attachment",
          "paws_team_tool",
          "paws_memory",
          "paws_finish_turn",
        ].includes(call.tool)
      )
        throw new Error("Unknown tool.");

      try {
        if (call.tool === "paws_memory" || call.tool === "paws_team_tool") {
          turn.signal.throwIfAborted();
          const blocked = turn.onTool?.(call.tool, "running");

          if (blocked)
            return {
              success: false,
              contentItems: [{ type: "inputText", text: blocked }],
            };

          const execute =
            call.tool === "paws_memory" ? turn.memoryTool : turn.teamTool;

          if (!execute) throw new Error("Team resource unavailable.");

          const result = await execute(call.arguments);
          const failed =
            typeof result === "object" &&
            result !== null &&
            "isError" in result &&
            result.isError === true;
          const checkpoint = turn.onTool?.(
            call.tool,
            failed ? "failed" : "completed",
          );

          return {
            success: !failed,
            contentItems: [
              { type: "inputText", text: JSON.stringify(result) },
              ...(checkpoint ? [{ type: "inputText", text: checkpoint }] : []),
            ],
          };
        }

        if (call.tool === "paws_finish_turn") {
          const options = Schema.decodeUnknownSync(
            Schema.Struct({ silent: Schema.Literal(true) }),
          )(call.arguments);

          if (!turn.onFinish) throw new Error("Silent completion unavailable.");

          turn.onFinish(options);

          return {
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: "Turn finished silently. End now without further tools or a final message.",
              },
            ],
          };
        }

        if (call.tool === "paws_read_attachment") {
          const { id } = Schema.decodeUnknownSync(
            Schema.Struct({ id: Schema.String }),
          )(call.arguments);

          if (!turn.readAttachment) throw new Error("Attachment unavailable.");

          return {
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify(await turn.readAttachment(id)),
              },
            ],
          };
        }

        let card;
        let attachments = Schema.decodeUnknownSync(ChatFileInputs)(
          call.arguments,
        ).attachments;

        if (call.tool === "request_secret") {
          const request = Schema.decodeUnknownSync(SecretRequest)(
            call.arguments,
          );
          card = secretCard(request.label, request.reason);
        } else {
          const decoded = Schema.decodeUnknownSync(ChatCard)(call.arguments);
          const legacyFiles = decoded.fields.filter(
            (field) => field.id === "paws_attachment",
          );

          if (legacyFiles.length) {
            attachments = legacyFiles.map((field) => ({ path: field.label }));
          }

          card = validateChatCard({
            ...decoded,
            fields: decoded.fields.filter(
              (field) => field.id !== "paws_attachment",
            ),
          });

          // Dynamic tool schemas persist with native threads. Keep older threads compatible.
          if (card.fields.some((field) => field.id === "paws_secret")) {
            if (card.fields.length !== 1 || card.actions.length)
              throw new Error("Request one secret at a time.");

            card = secretCard(card.fields[0]!.label, card.text);
          }
        }
        await turn.onMessage(call.callId, card, attachments);

        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text:
                card.secretRequest || card.actions.length || card.fields.length
                  ? "Controls delivered. End this turn now; do not sleep or poll. When the user responds, Paws starts a new turn with a paws_interaction tool result, not a user-authored chat message."
                  : "Delivered.",
            },
          ],
        };
      } catch {
        if (call.tool === "paws_memory" || call.tool === "paws_team_tool") {
          turn.onTool?.(call.tool, "failed");

          return {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text:
                  call.tool === "paws_memory"
                    ? "Memory unavailable. Check team membership and use at most 16000 characters."
                    : "Team integration failed. Check membership, configuration, authentication, and runtime availability. List integrations before using them.",
              },
            ],
          };
        }

        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text:
                call.tool === "paws_finish_turn"
                  ? "Could not finish silently. Call paws_finish_turn with silent: true."
                  : call.tool === "paws_read_attachment"
                    ? "Attachment unavailable. Check the attachment id."
                    : "Message not delivered. Use valid controls and up to 4 existing workspace files, at most 64 MB each (128 MB total). Files outside /workspace cannot be attached.",
            },
          ],
        };
      }
    },
  );
}
