import { Schema } from "effect";
import { ChatSelection, Conversation } from "./chat.ts";

export const RoutineFilter = Schema.Struct({
  path: Schema.String,
  operator: Schema.Literals(["equals", "in", "exists"]),
  value: Schema.optional(Schema.String),
});
export type RoutineFilter = typeof RoutineFilter.Type;

export type RoutineFilterGroup = {
  readonly combinator: "and" | "or";
  readonly rules: readonly (RoutineFilter | RoutineFilterGroup)[];
};

export const RoutineFilterGroup: Schema.Codec<RoutineFilterGroup> =
  Schema.Struct({
    combinator: Schema.Literals(["and", "or"]),
    rules: Schema.Array(
      Schema.Union([RoutineFilter, Schema.suspend(() => RoutineFilterGroup)]),
    ),
  });

export const RoutineTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("once"), at: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("interval"), minutes: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal("cron"),
    expression: Schema.String,
    timezone: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("webhook"),
    filters: RoutineFilterGroup,
  }),
]);
export type RoutineTrigger = typeof RoutineTrigger.Type;
export const SaveRoutine = Schema.Struct({
  name: Schema.String,
  instruction: Schema.String,
  enabled: Schema.Boolean,
  trigger: RoutineTrigger,
  missed: Schema.Literals(["skip", "latest"]),
  timeoutMinutes: Schema.Number,
});
export type SaveRoutine = typeof SaveRoutine.Type;
export const Routine = Schema.Struct({
  ...SaveRoutine.fields,
  id: Schema.String,
  agentId: Schema.String,
  revision: Schema.Number,
  nextAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  changedBy: Schema.Literals(["user", "agent"]),
  deleted: Schema.Boolean,
});
export type Routine = typeof Routine.Type;
export const RoutineRun = Schema.Struct({
  id: Schema.String,
  routineId: Schema.String,
  agentId: Schema.String,
  source: Schema.Literals(["schedule", "webhook", "manual", "retry"]),
  status: Schema.Literals([
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "expired",
  ]),
  createdAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  executedMs: Schema.optional(Schema.Number),
  finishedAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  retryOf: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.String),
  definition: Schema.optional(Routine),
  selection: Schema.optional(ChatSelection),
  context: Schema.optional(Schema.String),
  conversation: Schema.optional(Conversation),
});
export type RoutineRun = typeof RoutineRun.Type;
export const RoutineEvent = Schema.Struct({
  id: Schema.String,
  routineId: Schema.String,
  createdAt: Schema.String,
  outcome: Schema.String,
  runId: Schema.optional(Schema.String),
  deliveryId: Schema.optional(Schema.String),
});
export type RoutineEvent = typeof RoutineEvent.Type;
export const RoutineState = Schema.Struct({
  routines: Schema.Array(Routine),
  runs: Schema.Array(RoutineRun),
  nextRunCursor: Schema.optional(Schema.NullOr(Schema.Number)),
  events: Schema.Array(RoutineEvent),
});
