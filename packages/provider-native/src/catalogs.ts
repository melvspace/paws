// Model capability translations adapted from T3 Code provider drivers (MIT).
import { Schema } from "effect";
import type { ProviderModel, ProviderOption } from "@paws/contracts";
import { selectOption } from "@paws/provider-core";

const PiModel = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  thinkingLevelMap: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown),
  ),
});

export function piModels(input: unknown, thinking: string): ProviderModel[] {
  const { models } = Schema.decodeUnknownSync(
    Schema.Struct({ models: Schema.Array(PiModel) }),
  )(input);

  return models.map((model) => {
    const levels = model.reasoning
      ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter(
          (level) => {
            const mapped = model.thinkingLevelMap?.[level];

            return (
              mapped !== null &&
              (!(level === "xhigh" || level === "max") || mapped !== undefined)
            );
          },
        )
      : [];

    return {
      id: `${model.provider}/${model.id}`,
      name: model.name || model.id,
      options: levels.length
        ? [selectOption("thinking", "Thinking", levels, thinking)]
        : [],
    };
  });
}

const MuseModel = Schema.Struct({
  modelId: Schema.String,
  displayLabel: Schema.String,
  providerId: Schema.String,
  variants: Schema.optional(
    Schema.Union([Schema.Array(Schema.String), Schema.Literal("unknown")]),
  ),
  defaultReasoningEffort: Schema.optional(Schema.String),
});

export function museModels(input: unknown): ProviderModel[] {
  const catalog = Schema.decodeUnknownSync(
    Schema.Struct({
      providerId: Schema.String,
      models: Schema.Array(MuseModel),
    }),
  )(input);

  if (catalog.providerId !== "meta")
    throw new Error("Unexpected Muse provider.");

  return catalog.models
    .filter((model) => model.providerId === "meta")
    .map((model) => {
      const efforts = Array.isArray(model.variants)
        ? model.variants
        : ["low", "medium", "high", "xhigh", "max"];

      return {
        id: model.modelId,
        name: model.displayLabel || model.modelId,
        options: efforts.length
          ? [
              selectOption(
                "reasoningEffort",
                "Reasoning",
                efforts,
                model.defaultReasoningEffort ?? "high",
              ),
            ]
          : [],
      };
    });
}

export function grokModels(output: string) {
  const auth = /you are logged in/i.test(output)
    ? ("authenticated" as const)
    : /not authenticated|not logged in/i.test(output)
      ? ("unauthenticated" as const)
      : ("unknown" as const);
  const ids = [...output.matchAll(/^\s*[*-]\s+(\S+).*$/gm)].map(
    (match) => match[1]!,
  );

  return {
    auth,
    models: [...new Set(ids)].map((id) => ({
      id,
      name: id.replaceAll("-", " "),
      options: [],
    })),
  };
}

const FxStatus = Schema.Struct({ auth: Schema.optional(Schema.String) });
export function fxModels(status: unknown, catalog: unknown) {
  const { auth } = Schema.decodeUnknownSync(FxStatus)(status);
  const { ids } = Schema.decodeUnknownSync(
    Schema.Struct({ ids: Schema.Array(Schema.String) }),
  )(catalog);

  return {
    auth:
      auth === "missing"
        ? ("unauthenticated" as const)
        : auth
          ? ("authenticated" as const)
          : ("unknown" as const),
    models: ids.map((id) => ({
      id,
      name: id,
      options: [
        selectOption(
          "effort",
          "Effort",
          ["auto", "low", "medium", "high", "xhigh", "max"],
          "medium",
        ),
      ],
    })),
  };
}

const AcpChoice = Schema.Struct({ value: Schema.String, name: Schema.String });
const AcpConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  category: Schema.optional(Schema.String),
  currentValue: Schema.optional(Schema.String),
  options: Schema.optional(
    Schema.Array(
      Schema.Union([
        AcpChoice,
        Schema.Struct({ options: Schema.Array(AcpChoice) }),
      ]),
    ),
  ),
});
const AcpSession = Schema.Struct({
  models: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        currentModelId: Schema.String,
        availableModels: Schema.Array(
          Schema.Struct({ modelId: Schema.String, name: Schema.String }),
        ),
      }),
    ),
  ),
  configOptions: Schema.optional(Schema.Array(AcpConfig)),
});

export function acpModels(input: unknown): ProviderModel[] {
  const session = Schema.decodeUnknownSync(AcpSession)(input);
  const configs = session.configOptions ?? [];
  const modelConfig = configs.find(
    (config) => config.category === "model" || config.id === "model",
  );
  const flatten = (config: typeof AcpConfig.Type) =>
    (config.options ?? []).flatMap((choice) =>
      "value" in choice ? [choice] : choice.options,
    );
  const choices = modelConfig
    ? flatten(modelConfig)
    : (session.models?.availableModels ?? []).map((model) => ({
        value: model.modelId,
        name: model.name,
      }));
  const currentModel =
    modelConfig?.currentValue ?? session.models?.currentModelId;
  const options: ProviderOption[] = configs
    .filter(
      (config) =>
        config !== modelConfig &&
        config.type === "select" &&
        config.category !== "mode" &&
        config.id !== "mode",
    )
    .map((config) => ({
      id: config.id,
      label: config.name,
      choices: flatten(config).map((choice) => ({
        id: choice.value,
        label: choice.name,
      })),
      defaultValue: config.currentValue ?? flatten(config)[0]?.value ?? "",
    }))
    .filter((option) => option.choices.length > 0);

  // ACP config is session/model-scoped. Never apply one model's traits to every row.
  return choices.map((choice) => ({
    id: choice.value,
    name: choice.name,
    options: choice.value === currentModel ? options : [],
  }));
}
