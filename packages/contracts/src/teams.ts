import { Schema } from "effect";

export const TeamIntegration = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["cli", "mcp-stdio", "mcp-http"]),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
});
export type TeamIntegration = typeof TeamIntegration.Type;

export const TeamToolRequest = Schema.Struct({
  teamId: Schema.String,
  action: Schema.Literals([
    "list",
    "install",
    "configure",
    "tools",
    "call",
    "exec",
  ]),
  script: Schema.optional(Schema.String),
  integrationId: Schema.optional(Schema.String),
  integration: Schema.optional(TeamIntegration),
  tool: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  args: Schema.optional(Schema.Array(Schema.String)),
  // One-use private input references, never credential values.
  secrets: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type TeamToolRequest = typeof TeamToolRequest.Type;

export const SaveTeam = Schema.Struct({
  name: Schema.String,
  memory: Schema.String,
  integrations: Schema.optional(Schema.Array(TeamIntegration)),
});
export type SaveTeam = typeof SaveTeam.Type;

export const Team = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  memory: Schema.String,
  integrations: Schema.optional(Schema.Array(TeamIntegration)),
  createdAt: Schema.String,
});
export type Team = typeof Team.Type;

export const MoveAgentTeam = Schema.Struct({
  fromTeamId: Schema.NullOr(Schema.String),
  toTeamId: Schema.NullOr(Schema.String),
});
export type MoveAgentTeam = typeof MoveAgentTeam.Type;
