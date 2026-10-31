import type { ProviderDescriptor } from "@paws/provider-core";

export const codexProvider = {
  id: "codex",
  name: "Codex",
  authentication: "subscription",
} as const satisfies ProviderDescriptor;

// Execute inside an isolated runtime; never spawn on the host from a UI handler.
export function codexLaunch(home: string) {
  return {
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
    env: { CODEX_HOME: home },
    initialize: {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "paws", title: "Paws", version: "0.1.0" },
      },
    },
  };
}

export { discoverCodex } from "./discovery.ts";

export { signInCodex } from "./auth.ts";
export { runCodexTurn, type ChatCredentials } from "./chat.ts";
export { recoverCodexHistory } from "./recoverHistory.ts";
