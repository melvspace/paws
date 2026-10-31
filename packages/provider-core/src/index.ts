import type { Effect } from "effect";
import type { Agent } from "@paws/contracts";

export interface ProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly authentication: "subscription" | "api-key";
}

export interface ProviderSession {
  readonly id: string;
  prompt(input: string): Effect.Effect<void, Error>;
  interrupt(): Effect.Effect<void, Error>;
  close(): Effect.Effect<void, Error>;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  start(agent: Agent): Effect.Effect<ProviderSession, Error>;
}

export * from "./catalog.ts";
export * from "./chat.ts";

export { chatInstructions, chatHarnessRevision } from "./instructions.ts";
