import { Schema } from "effect";
import { ChatSelection, TextGenerationSettings } from "@paws/contracts";
import { environmentFetch } from "./transport.ts";

const TextGenerationState = Schema.Struct({
  ...TextGenerationSettings.fields,
  effectiveSelection: Schema.NullOr(ChatSelection),
  errors: Schema.Array(
    Schema.Struct({ agentId: Schema.String, error: Schema.String }),
  ),
});

export async function textGenerationSettings(
  settings?: TextGenerationSettings,
) {
  const response = await environmentFetch(
    "/api/text-generation",
    settings
      ? {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
        }
      : undefined,
  );

  if (!response.ok)
    throw new Error(
      "Could not load or save the text generation model. Check the provider and retry.",
    );

  return Schema.decodeUnknownSync(TextGenerationState)(await response.json());
}
