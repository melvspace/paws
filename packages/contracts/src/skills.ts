import { Schema } from "effect";

export const AgentSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  // Path inside the agent runtime, never a host path.
  path: Schema.String,
});
export type AgentSkill = typeof AgentSkill.Type;

export const AgentSkills = Schema.Array(AgentSkill);
