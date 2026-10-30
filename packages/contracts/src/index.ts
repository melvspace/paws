import { Schema } from "effect";
import { ProviderSnapshot } from "./providers.ts";

export const CreateAgent = Schema.Struct({
  name: Schema.String,
});
export type CreateAgent = typeof CreateAgent.Type;

export const UpdateAgent = CreateAgent;
export type UpdateAgent = typeof UpdateAgent.Type;

export const Agent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.Literal("codex"),
  status: Schema.Literal("configured"),
  createdAt: Schema.String,
});
export type Agent = typeof Agent.Type;

export const Snapshot = Schema.Struct({
  agents: Schema.Array(Agent),
  providers: Schema.optional(Schema.Array(ProviderSnapshot)),
});
export type Snapshot = typeof Snapshot.Type;

export * from "./providers.ts";
