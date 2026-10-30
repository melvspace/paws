import { describe, expect, it } from "vite-plus/test";
import type { Agent } from "@paws/contracts";
import { readWorkspace, selectedAgent, writeWorkspace } from "./state.ts";

const ada: Agent = {
  id: "ada",
  name: "Ada",
  provider: "codex",
  status: "configured",
  createdAt: "2026-10-31T00:00:00.000Z",
};
const grace: Agent = { ...ada, id: "grace", name: "Grace" };

function memoryStorage() {
  const values = new Map<string, string>();

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("workspace selection", () => {
  it("selects linked agents and falls back when the selected agent is removed", () => {
    expect(selectedAgent([ada, grace], "#agent-grace")).toBe(grace);
    expect(selectedAgent([ada], "#agent-grace")).toBe(ada);
    expect(selectedAgent([ada, grace], "")).toBe(ada);
    expect(selectedAgent([], "#agent-grace")).toBeNull();
  });
});

describe("workspace persistence", () => {
  it("keeps drafts and collapsed panels separate across agent switches", () => {
    const storage = memoryStorage();
    const original = readWorkspace(storage, ada.id);
    const changed = {
      ...original,
      draft: "Review the latest changes",
      sidebarOpen: false,
      bottomOpen: true,
    };
    writeWorkspace(storage, ada.id, changed);
    expect(readWorkspace(storage, grace.id)).toEqual(original);
    expect(readWorkspace(storage, ada.id)).toEqual(changed);
  });

  it("recovers defaults from malformed data and validates individual preferences", () => {
    const storage = memoryStorage();
    const defaults = readWorkspace(storage, ada.id);
    storage.setItem("paws.workspace.ada", "invalid json");
    expect(readWorkspace(storage, ada.id)).toEqual(defaults);
    storage.setItem(
      "paws.workspace.ada",
      JSON.stringify({
        draft: 17,
        chatOpen: false,
        sidebarOpen: false,
      }),
    );
    expect(readWorkspace(storage, ada.id)).toEqual({
      ...defaults,
      sidebarOpen: false,
    });
  });

  it("keeps the workspace usable when browser storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("Blocked");
      },
      setItem: () => {
        throw new Error("Blocked");
      },
    };
    const state = readWorkspace(blocked, ada.id);
    expect(state.sidebarOpen).toBe(true);
    expect(() => writeWorkspace(blocked, ada.id, state)).not.toThrow();
  });
});
