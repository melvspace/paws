import { Schema } from "effect";
import { Conversation } from "./chat.ts";
import { ProviderSnapshot } from "./providers.ts";
import { AgentReplyWait } from "./teamwork.ts";
import { Team } from "./teams.ts";
import { MemoryEntry } from "./memories.ts";
import { AgentAvatar } from "./avatars.ts";

export const CreateAgent = Schema.Struct({
  name: Schema.String,
  role: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  avatar: Schema.optional(AgentAvatar),
  teamId: Schema.optional(Schema.NullOr(Schema.String)),
  sandbox: Schema.optional(Schema.Boolean),
  memory: Schema.optional(Schema.String),
});
export type CreateAgent = typeof CreateAgent.Type;

export const UpdateAgent = Schema.Struct({
  name: Schema.String,
  role: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  avatar: Schema.optional(AgentAvatar),
  memory: Schema.optional(Schema.String),
  sandbox: Schema.optional(Schema.Boolean),
});
export type UpdateAgent = typeof UpdateAgent.Type;

export const Agent = Schema.Struct({
  profileOverrides: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.Boolean),
      description: Schema.optional(Schema.Boolean),
    }),
  ),
  memories: Schema.optional(Schema.Array(MemoryEntry)),
  id: Schema.String,
  name: Schema.String,
  role: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  avatar: Schema.optional(AgentAvatar),
  teamId: Schema.optional(Schema.NullOr(Schema.String)),
  sandbox: Schema.optional(Schema.Boolean),
  memory: Schema.optional(Schema.String),
  provider: Schema.Literal("codex"),
  status: Schema.Literal("configured"),
  createdAt: Schema.String,
});
export type Agent = typeof Agent.Type;

export const Snapshot = Schema.Struct({
  agents: Schema.Array(Agent),
  teamworkRevision: Schema.optional(Schema.Number),
  peerWaits: Schema.optional(Schema.Array(AgentReplyWait)),
  teamworkActiveAgentIds: Schema.optional(Schema.Array(Schema.String)),
  teams: Schema.optional(Schema.Array(Team)),
  providers: Schema.optional(Schema.Array(ProviderSnapshot)),
  conversations: Schema.optional(Schema.Array(Conversation)),
});
export type Snapshot = typeof Snapshot.Type;

export * from "./providers.ts";

export * from "./chat.ts";
export * from "./skills.ts";
export * from "./avatars.ts";

export * from "./teams.ts";

export * from "./teamwork.ts";

export * from "./routines.ts";

export * from "./memories.ts";

export * from "./browser.ts";

export * from "./environments.ts";

export * from "./pairing.ts";

export * from "./textGeneration.ts";
