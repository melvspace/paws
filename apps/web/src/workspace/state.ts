import type { Agent } from "@paws/contracts";
import { modelKey } from "@paws/provider-core";

export interface WorkspaceState {
  draft: string;
  model: string;
  options: Record<string, string>;
  sidebarOpen: boolean;
  bottomOpen: boolean;
}

const defaults: WorkspaceState = {
  draft: "",
  model: "",
  options: {},
  sidebarOpen: true,
  bottomOpen: false,
};

export function selectedAgent(agents: readonly Agent[], hash: string) {
  const id = hash.startsWith("#agent-") ? hash.slice(7) : null;

  return agents.find((agent) => agent.id === id) ?? agents[0] ?? null;
}

export function readWorkspace(
  storage: Pick<Storage, "getItem">,
  agentId: string,
): WorkspaceState {
  try {
    const value: unknown = JSON.parse(
      storage.getItem(`paws.workspace.${agentId}`) ?? "null",
    );

    if (!value || typeof value !== "object") {
      return { ...defaults };
    }

    return {
      options: readOptions(value),
      model:
        "model" in value && typeof value.model === "string" && value.model
          ? value.model.includes(":")
            ? value.model
            : modelKey("codex", value.model)
          : "",
      draft:
        "draft" in value && typeof value.draft === "string" ? value.draft : "",
      sidebarOpen:
        "sidebarOpen" in value && typeof value.sidebarOpen === "boolean"
          ? value.sidebarOpen
          : defaults.sidebarOpen,
      bottomOpen:
        "bottomOpen" in value && typeof value.bottomOpen === "boolean"
          ? value.bottomOpen
          : defaults.bottomOpen,
    };
  } catch {
    return { ...defaults };
  }
}

export function writeWorkspace(
  storage: Pick<Storage, "setItem">,
  agentId: string,
  state: WorkspaceState,
) {
  try {
    storage.setItem(`paws.workspace.${agentId}`, JSON.stringify(state));
  } catch {
    // Keep the workspace usable when storage is unavailable or full.
  }
}

function readOptions(value: object): Record<string, string> {
  if (
    "options" in value &&
    value.options &&
    typeof value.options === "object" &&
    !Array.isArray(value.options)
  ) {
    return Object.fromEntries(
      Object.entries(value.options).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  return {
    ...("reasoning" in value && typeof value.reasoning === "string"
      ? { reasoningEffort: value.reasoning }
      : {}),
    ...("serviceTier" in value && typeof value.serviceTier === "string"
      ? {
          serviceTier:
            value.serviceTier === "standard" ? "default" : value.serviceTier,
        }
      : {}),
  };
}
