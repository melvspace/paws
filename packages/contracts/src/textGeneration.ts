import { Schema } from "effect";
import { ChatSelection } from "./chat.ts";

export const TextGenerationSettings = Schema.Struct({
  selection: Schema.NullOr(ChatSelection),
});
export type TextGenerationSettings = typeof TextGenerationSettings.Type;

export const AgentProfile = Schema.Struct({
  role: Schema.String.check(Schema.isMaxLength(160)),
  description: Schema.String.check(Schema.isMaxLength(2000)),
});
export type AgentProfile = typeof AgentProfile.Type;
