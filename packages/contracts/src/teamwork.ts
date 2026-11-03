import { Schema } from "effect";
import {
  ChatAttachment,
  ChatFileInput,
  ChatSelection,
  PeerMessageRecovery,
} from "./chat.ts";

export const TeamTaskStatus = Schema.Literals([
  "assigned",
  "review",
  "done",
  "blocked",
  "cancelled",
]);
export type TeamTaskStatus = typeof TeamTaskStatus.Type;

export const TeamTask = Schema.Struct({
  id: Schema.String,
  teamId: Schema.optional(Schema.String),
  title: Schema.String,
  description: Schema.String,
  ownerId: Schema.String,
  reviewerId: Schema.optional(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  status: TeamTaskStatus,
  revision: Schema.Number,
  summary: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type TeamTask = typeof TeamTask.Type;

export const TeamEvent = Schema.Struct({
  id: Schema.String,
  teamId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  taskRevision: Schema.optional(Schema.Number),
  retryOf: Schema.optional(Schema.String),
  rootEventId: Schema.optional(Schema.String),
  depth: Schema.optional(Schema.Number),
  kind: Schema.Literals([
    "message",
    "reply",
    "delegated",
    "handoff",
    "submitted",
    "approved",
    "changes_requested",
    "blocked",
    "cancelled",
  ]),
  fromAgentId: Schema.NullOr(Schema.String),
  toAgentId: Schema.NullOr(Schema.String),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  expectsReply: Schema.optional(Schema.Boolean),
  replyToMessageId: Schema.optional(Schema.String),
  originConversationId: Schema.optional(Schema.String),
  originRequestId: Schema.optional(Schema.String),
  returnToConversationId: Schema.optional(Schema.String),
  delivery: Schema.Literals([
    "queued",
    "running",
    "delivered",
    "failed",
    "interrupted",
    "skipped",
    "cancelled",
  ]),
  error: Schema.optional(Schema.String),
  createdAt: Schema.String,
});
export type TeamEvent = typeof TeamEvent.Type;

export const TeamworkState = Schema.Struct({
  tasks: Schema.Array(TeamTask),
  events: Schema.Array(TeamEvent),
});
export type TeamworkState = typeof TeamworkState.Type;

// Agent identity is supplied by the execution boundary, never by tool arguments.
export const TeamworkRequest = Schema.Struct({
  action: Schema.Literals([
    "list",
    "message",
    "delegate",
    "handoff",
    "submit",
    "review",
    "block",
    "cancel",
    "retry",
    "interrupt",
  ]),
  taskId: Schema.optional(Schema.String),
  eventId: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Number),
  toAgentId: Schema.optional(Schema.String),
  toAgentIds: Schema.optional(Schema.Array(Schema.String)),
  attachments: Schema.optional(Schema.Array(ChatFileInput)),
  expectsReply: Schema.optional(Schema.Boolean),
  replyToMessageId: Schema.optional(Schema.String),
  reviewerId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  verdict: Schema.optional(Schema.Literals(["approve", "request_changes"])),
});
export type TeamworkRequest = typeof TeamworkRequest.Type;

export const AgentManagementRequest = Schema.Struct({
  action: Schema.Literals(["read", "create", "update"]),
  agentId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  sandbox: Schema.optional(Schema.Boolean),
  selection: Schema.optional(ChatSelection),
});
export type AgentManagementRequest = typeof AgentManagementRequest.Type;

export const AgentReplyWait = Schema.Struct({
  agentId: Schema.String,
  requestId: Schema.String,
  toAgentId: Schema.String,
  toName: Schema.String,
  batchId: Schema.String,
  recovery: Schema.optional(PeerMessageRecovery),
  status: Schema.Literals([
    "queued",
    "working",
    "waiting",
    "done",
    "failed",
    "interrupted",
  ]),
});
export type AgentReplyWait = typeof AgentReplyWait.Type;

export const PeerRetryResult = Schema.Struct({ requestId: Schema.String });
export type PeerRetryResult = typeof PeerRetryResult.Type;
