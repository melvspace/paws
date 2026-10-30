import { expect, it } from "vite-plus/test";
import {
  acpModels,
  fxModels,
  grokModels,
  museModels,
  piModels,
} from "./catalogs.ts";
import { claudeModel, cursorModel } from "./sdk.ts";

it("uses Pi per-model thinkingLevelMap instead of globally advertising max effort", () => {
  const models = piModels(
    {
      models: [
        { provider: "a", id: "plain", reasoning: false },
        {
          provider: "a",
          id: "reasoner",
          reasoning: true,
          thinkingLevelMap: { low: null, xhigh: 10 },
        },
      ],
    },
    "medium",
  );
  expect(models[0]?.options).toEqual([]);
  expect(models[1]?.options[0]?.choices.map((choice) => choice.id)).toEqual([
    "off",
    "minimal",
    "medium",
    "high",
    "xhigh",
  ]);
});

it("keeps ACP traits scoped to the current model and preserves grouped option IDs", () => {
  const models = acpModels({
    models: {
      currentModelId: "one",
      availableModels: [
        { modelId: "one", name: "One" },
        { modelId: "two", name: "Two" },
      ],
    },
    configOptions: [
      {
        id: "budget",
        name: "Thinking budget",
        type: "select",
        currentValue: "deep",
        options: [
          { name: "Budgets", options: [{ value: "deep", name: "Deep" }] },
        ],
      },
    ],
  });
  expect(models[0]?.options[0]).toMatchObject({
    id: "budget",
    defaultValue: "deep",
    choices: [{ id: "deep", label: "Deep" }],
  });
  expect(models[1]?.options).toEqual([]);
});

it("honors native Muse empty efforts and exposes only Claude advertised controls", () => {
  expect(
    museModels({
      providerId: "meta",
      models: [
        {
          providerId: "meta",
          modelId: "muse",
          displayLabel: "Muse",
          variants: [],
        },
      ],
    })[0]?.options,
  ).toEqual([]);
  expect(
    claudeModel({
      value: "test",
      displayName: "Test",
      description: "",
      supportsEffort: false,
      supportsFastMode: false,
    }).options,
  ).toEqual([]);
  expect(
    claudeModel({
      value: "test",
      displayName: "Test",
      description: "",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
      supportsFastMode: true,
    }).options.map((option) => option.id),
  ).toEqual(["effort", "fastMode"]);
});

it("preserves Cursor parameter defaults and native values", () => {
  const model = cursorModel({
    id: "test",
    displayName: "Test",
    parameters: [
      {
        id: "fast",
        displayName: "Fast",
        values: [
          { value: "true", displayName: "Fast" },
          { value: "false", displayName: "Standard" },
        ],
      },
    ],
    variants: [
      {
        displayName: "Default",
        isDefault: true,
        params: [{ id: "fast", value: "false" }],
      },
    ],
  });
  expect(model.options[0]).toMatchObject({
    id: "fastMode",
    defaultValue: "false",
  });
});

it("does not treat Grok's successful CLI exit as proof of authentication", () => {
  expect(grokModels("Not authenticated")).toEqual({
    auth: "unauthenticated",
    models: [],
  });
  expect(grokModels("Available models:\n* grok-test (default)")).toMatchObject({
    auth: "unknown",
    models: [{ id: "grok-test" }],
  });
  expect(fxModels({ auth: "missing" }, { ids: ["test"] }).auth).toBe(
    "unauthenticated",
  );
});
