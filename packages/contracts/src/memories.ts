import { Schema } from "effect";

export const essentialMemoryBudgetBytes = 4096;
export const essentialMemoryOwnerBudgetBytes = 2048;
export const essentialMemoryOwnerLimit = 4;
export const MemoryInclusion = Schema.Literals(["essential", "searchable"]);

export const MemoryEntry = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  inclusion: Schema.optional(MemoryInclusion),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type MemoryEntry = typeof MemoryEntry.Type;

export const MemoryRequest = Schema.Struct({
  action: Schema.Literals([
    "list",
    "search",
    "read",
    "create",
    "update",
    "delete",
  ]),
  inclusion: Schema.optional(MemoryInclusion),
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  after: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  expected: Schema.optional(Schema.String),
});
export type MemoryRequest = typeof MemoryRequest.Type;
