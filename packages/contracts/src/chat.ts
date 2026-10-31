import { Schema } from "effect";
import { ProviderDriver } from "./providers.ts";

export const ChatAction = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});
export const ChatField = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  required: Schema.Boolean,
  type: Schema.Literals(["text", "textarea", "select"]),
  choices: Schema.Array(ChatAction),
});
export const ChatCard = Schema.Struct({
  text: Schema.String,
  actions: Schema.Array(ChatAction),
  fields: Schema.Array(ChatField),
  secretRequest: Schema.optional(Schema.Struct({ label: Schema.String })),
});
export type ChatCard = typeof ChatCard.Type;
export const ChatAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  size: Schema.optional(Schema.Number),
  path: Schema.optional(Schema.String),
});
export type ChatAttachment = typeof ChatAttachment.Type;
export const ChatFileInput = Schema.Struct({
  path: Schema.String,
  name: Schema.optional(Schema.String),
});
export type ChatFileInput = typeof ChatFileInput.Type;
export const ChatFileInputs = Schema.Struct({
  attachments: Schema.optional(Schema.Array(ChatFileInput)),
});
export const ChatDelivery = Schema.Literals([
  "queued",
  "steered",
  "delivered",
  "failed",
  "cancelled",
]);
export const FollowUpMode = Schema.Literals(["steer", "queue"]);
export type FollowUpMode = typeof FollowUpMode.Type;
export const ChatInteraction = Schema.Struct({
  source: Schema.Literal("paws"),
  type: Schema.Literals([
    "action_clicked",
    "form_submitted",
    "secret_saved",
    "secret_declined",
  ]),
  eventId: Schema.String,
  delivery: Schema.optional(ChatDelivery),
  messageId: Schema.String,
  prompt: Schema.String,
  secretRef: Schema.optional(Schema.String),
  action: ChatAction,
  fields: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      value: Schema.String,
      displayValue: Schema.String,
    }),
  ),
});
export type ChatInteraction = typeof ChatInteraction.Type;
export const ChatModelReference = Schema.Struct({
  providerId: Schema.String,
  modelId: Schema.String,
  name: Schema.String,
  driver: Schema.optional(ProviderDriver),
});
export type ChatModelReference = typeof ChatModelReference.Type;
export const ChatHandoff = Schema.Struct({
  id: Schema.String,
  kind: Schema.optional(
    Schema.Literals(["provider-switch", "session-restoration"]),
  ),
  beforeMessageId: Schema.String,
  from: Schema.Array(ChatModelReference),
  to: ChatModelReference,
  status: Schema.Literals(["pending", "completed", "failed"]),
});
export type ChatHandoff = typeof ChatHandoff.Type;
export const ChatMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: Schema.String,
  model: Schema.optional(ChatModelReference),
  streaming: Schema.optional(Schema.Boolean),
  card: Schema.optional(ChatCard),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  response: Schema.optional(Schema.String),
  delivery: Schema.optional(ChatDelivery),
  interaction: Schema.optional(ChatInteraction),
});
export type ChatMessage = typeof ChatMessage.Type;
export const ChatSelection = Schema.Struct({
  providerId: Schema.String,
  modelId: Schema.String,
  options: Schema.Record(Schema.String, Schema.String),
});
export type ChatSelection = typeof ChatSelection.Type;
export const SendChat = Schema.Struct({
  requestId: Schema.String,
  attachmentIds: Schema.optional(Schema.Array(Schema.String)),
  mode: Schema.optional(FollowUpMode),
  text: Schema.String,
  selection: ChatSelection,
  reply: Schema.optional(
    Schema.Struct({
      messageId: Schema.String,
      actionId: Schema.String,
      values: Schema.Record(Schema.String, Schema.String),
      secret: Schema.optional(Schema.String),
    }),
  ),
});
export type SendChat = typeof SendChat.Type;
// Restart-safe inputs never contain secret values or one-use secret references.
export const ChatQueuedInput = Schema.Struct({
  requestId: Schema.String,
  attachmentIds: Schema.optional(Schema.Array(Schema.String)),
  text: Schema.String,
  selection: ChatSelection,
  held: Schema.Boolean,
  steering: Schema.optional(Schema.Boolean),
  reply: Schema.optional(
    Schema.Struct({
      messageId: Schema.String,
      actionId: Schema.String,
      values: Schema.Record(Schema.String, Schema.String),
    }),
  ),
});
export type ChatQueuedInput = typeof ChatQueuedInput.Type;
export const ChatQueueAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["resume", "remove"]),
    requestId: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("edit"),
    requestId: Schema.String,
    text: Schema.String,
  }),
]);
export type ChatQueueAction = typeof ChatQueueAction.Type;
export const ChatInterruptedTurn = Schema.Struct({
  requestId: Schema.String,
  selection: ChatSelection,
  activity: Schema.Literals(["reply", "compact"]),
});
export type ChatInterruptedTurn = typeof ChatInterruptedTurn.Type;

export const ContextUsage = Schema.Struct({
  usedTokens: Schema.Number,
  maxTokens: Schema.NullOr(Schema.Number),
  totalProcessedTokens: Schema.optional(Schema.Number),
});
export type ContextUsage = typeof ContextUsage.Type;
export const Conversation = Schema.Struct({
  agentId: Schema.String,
  revision: Schema.Number,
  contextUsage: Schema.optional(ContextUsage),
  activity: Schema.optional(Schema.Literals(["reply", "compact"])),
  toolActivity: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literals(["running", "completed", "failed"]),
      count: Schema.Number,
    }),
  ),
  status: Schema.Literals(["idle", "running", "error"]),
  error: Schema.NullOr(Schema.String),
  selection: Schema.NullOr(ChatSelection),
  messages: Schema.Array(ChatMessage),
  handoffs: Schema.optional(Schema.Array(ChatHandoff)),
  queue: Schema.optional(Schema.Array(ChatQueuedInput)),
  interrupted: Schema.optional(ChatInterruptedTurn),
});
export type Conversation = typeof Conversation.Type;

// Tool output is data, never HTML, script, a URL to execute, or a shell command.
export function validateChatCard(card: ChatCard): ChatCard {
  if (
    !card.text.trim() ||
    card.text.length > 8000 ||
    card.actions.length > 6 ||
    card.fields.length > 8
  ) {
    throw new Error(
      "Use a message of 1–8000 characters, up to 6 actions and 8 fields.",
    );
  }

  const validId = (value: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(value);
  const validLabel = (value: string) =>
    value.trim().length > 0 && value.length <= 120;
  const unique = (items: readonly { id: string }[]) =>
    new Set(items.map((item) => item.id)).size === items.length;

  if (
    card.secretRequest &&
    (!validLabel(card.secretRequest.label) ||
      card.actions.length ||
      card.fields.length)
  ) {
    throw new Error(
      "Secret requests need a short label and no ordinary controls.",
    );
  }

  if (
    !unique(card.actions) ||
    !unique(card.fields) ||
    card.actions.some(
      (action) => !validId(action.id) || !validLabel(action.label),
    )
  ) {
    throw new Error("Actions and fields need unique IDs and short labels.");
  }

  for (const field of card.fields) {
    if (
      !validId(field.id) ||
      !validLabel(field.label) ||
      field.choices.length > 20 ||
      !unique(field.choices) ||
      field.choices.some(
        (choice) => !validId(choice.id) || !validLabel(choice.label),
      ) ||
      (field.type === "select" && !field.choices.length)
    ) {
      throw new Error("Invalid form field.");
    }
  }

  return card;
}
