import { describe, expect, it } from "vite-plus/test";
import { normalizeModelOptions } from "@paws/provider-core";
import { availableModels, filterModels, readModelFavorites } from "./models.ts";
import { readWorkspace, writeWorkspace } from "./state.ts";
import { codexFixture, modelFixtures } from "../../test/providerFixtures.ts";

describe("provider model preferences", () => {
  it("searches across providers and preserves empty favorites", () => {
    expect(filterModels(modelFixtures, "", "favorites", [])).toEqual([]);
    expect(filterModels(modelFixtures, "sol codex", "favorites", [])).toEqual([
      modelFixtures[0],
    ]);
    expect(filterModels(modelFixtures, "unknown", "codex", [])).toEqual([]);
    expect(readModelFavorites({ getItem: () => "[]" })).toEqual([]);
    expect(
      readModelFavorites({ getItem: () => '[1,"gpt-6-astra","gpt-6-astra"]' }),
    ).toEqual(["codex:gpt-6-astra"]);
    expect(readModelFavorites({ getItem: () => "invalid" })).toEqual([]);
  });

  it("namespaces model IDs by instance and excludes disabled or failed providers", () => {
    const other = {
      ...codexFixture,
      config: { ...codexFixture.config, id: "other", name: "Work account" },
    };
    const all = availableModels([codexFixture, other]);
    expect(new Set(all.map((model) => model.id)).size).toBe(4);
    expect(availableModels([{ ...other, status: "error" }])).toEqual([]);
    expect(
      availableModels([
        { ...other, config: { ...other.config, enabled: false } },
      ]),
    ).toEqual([]);
  });

  it("drops unsupported values and removes absent service tiers", () => {
    const model = codexFixture.models[1]!;
    expect(
      normalizeModelOptions(model, {
        reasoningEffort: "impossible",
        serviceTier: "priority",
        stale: "value",
      }),
    ).toEqual({ reasoningEffort: "medium", serviceTier: "default" });
    expect(
      normalizeModelOptions(
        { ...model, options: [model.options[0]!] },
        { reasoningEffort: "high", serviceTier: "fast" },
      ),
    ).toEqual({ reasoningEffort: "high" });
    expect(normalizeModelOptions(undefined, { effort: "max" })).toEqual({});
  });

  it("persists per-agent choices, migrates old preferences, and preserves temporarily unavailable models", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    writeWorkspace(storage, "ada", {
      ...readWorkspace(storage, "ada"),
      model: "other:gpt-6-astra",
      options: { effort: "high" },
    });
    expect(readWorkspace(storage, "ada").model).toBe("other:gpt-6-astra");
    expect(readWorkspace(storage, "ada").options).toEqual({ effort: "high" });
    expect(readWorkspace(storage, "grace").model).toBe("");
    storage.setItem(
      "paws.workspace.ada",
      JSON.stringify({
        draft: "hello",
        model: "gpt-6-astra",
        reasoning: "xhigh",
        serviceTier: "standard",
      }),
    );
    expect(readWorkspace(storage, "ada")).toMatchObject({
      draft: "hello",
      model: "codex:gpt-6-astra",
      options: { reasoningEffort: "xhigh", serviceTier: "default" },
    });
    storage.setItem(
      "paws.workspace.ada",
      '{"options":{"effort":5,"fastMode":"true"}}',
    );
    expect(readWorkspace(storage, "ada").options).toEqual({ fastMode: "true" });
  });
});
