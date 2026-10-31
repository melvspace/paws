import { Schema } from "effect";

export const avatarAnimals = [
  "cat",
  "dog",
  "fox",
  "bear",
  "rabbit",
  "panda",
  "mouse",
  "raccoon",
] as const;

export const avatarColors = {
  red: "#e8483f",
  orange: "#f08a24",
  green: "#3ecf8e",
  blue: "#3b93f0",
  pink: "#e152b0",
} as const;

export const avatarColorNames = [
  "red",
  "orange",
  "green",
  "blue",
  "pink",
] as const;

export const AgentAvatar = Schema.Struct({
  animal: Schema.Literals(avatarAnimals),
  color: Schema.Literals(avatarColorNames),
});
export type AgentAvatar = typeof AgentAvatar.Type;

export function defaultAgentAvatar(seed: string): AgentAvatar {
  let hash = 0;

  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return {
    animal: avatarAnimals[hash % avatarAnimals.length]!,
    color:
      avatarColorNames[
        Math.floor(hash / avatarAnimals.length) % avatarColorNames.length
      ]!,
  };
}
