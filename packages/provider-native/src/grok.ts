// Grok reports reasoning metadata during ACP initialize; never open a session for this probe.
import { Schema } from "effect";
import { selectOption } from "@paws/provider-core";
import {
  runCommand,
  withJsonRpc,
  type ProbeLaunch,
} from "@paws/provider-core/process";
import { grokModels } from "./catalogs.ts";

const Effort = Schema.Struct({
  value: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Boolean),
  isDefault: Schema.optional(Schema.Boolean),
});
const Initialized = Schema.Struct({
  _meta: Schema.optional(
    Schema.Struct({
      modelState: Schema.optional(
        Schema.Struct({
          availableModels: Schema.Array(
            Schema.Struct({
              modelId: Schema.String,
              name: Schema.String,
              _meta: Schema.optional(
                Schema.Struct({
                  supportsReasoningEffort: Schema.optional(Schema.Boolean),
                  reasoningEffort: Schema.optional(Schema.String),
                  reasoningEfforts: Schema.optional(Schema.Array(Effort)),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

export async function discoverGrok(launch: ProbeLaunch) {
  const inventory = grokModels(
    await runCommand({ ...launch, args: [...launch.args, "models"] }),
  );

  if (inventory.auth === "unauthenticated") return inventory;

  try {
    const models = await withJsonRpc(
      { ...launch, args: [...launch.args, "agent", "stdio"] },
      async (rpc) => {
        const init = Schema.decodeUnknownSync(Initialized)(
          await rpc.request("initialize", {
            protocolVersion: 1,
            clientInfo: { name: "paws", version: "0.1.0" },
            clientCapabilities: {},
          }),
        );

        return (init._meta?.modelState?.availableModels ?? []).map((model) => {
          const efforts =
            model._meta?.supportsReasoningEffort === false
              ? []
              : (model._meta?.reasoningEfforts ?? []);
          const values = efforts
            .map((effort) => effort.value ?? effort.id ?? "")
            .filter((value) => /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(value));
          const defaultEffort = efforts.find(
            (effort) => effort.default || effort.isDefault,
          );
          const option = selectOption(
            "reasoningEffort",
            "Reasoning",
            values,
            model._meta?.reasoningEffort ??
              defaultEffort?.value ??
              defaultEffort?.id,
          );

          return {
            id: model.modelId,
            name: model.name,
            options: values.length
              ? [
                  {
                    ...option,
                    choices: option.choices.map((choice) => ({
                      ...choice,
                      label:
                        efforts.find(
                          (effort) => (effort.value ?? effort.id) === choice.id,
                        )?.label ?? choice.label,
                    })),
                  },
                ]
              : [],
          };
        });
      },
    );

    return { ...inventory, models: models.length ? models : inventory.models };
  } catch {
    launch.signal.throwIfAborted();

    return inventory;
  }
}
