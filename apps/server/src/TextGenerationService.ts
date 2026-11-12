import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import {
  AgentProfile,
  TextGenerationSettings,
  type ChatSelection,
} from "@paws/contracts";
import { generateCodexText } from "@paws/provider-codex";
import { generateClaudeText, providerLaunch } from "@paws/provider-native";
import type { makeProviderService } from "./ProviderService.ts";

export function makeTextGenerationService(
  root: string,
  providers: Pick<
    ReturnType<typeof makeProviderService>,
    "list" | "environment"
  >,
) {
  const db = new DatabaseSync(join(root, "text-generation.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL)",
  );
  const shutdown = new AbortController();
  const available = () =>
    providers
      .list()
      .filter(
        (provider) =>
          provider.config.enabled &&
          provider.status === "ready" &&
          ["codex", "claudeAgent"].includes(provider.config.driver),
      );
  const read = (): TextGenerationSettings => {
    const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();

    return row
      ? Schema.decodeUnknownSync(TextGenerationSettings)(
          JSON.parse(String(row.data)),
        )
      : { selection: null };
  };
  const selection = (): ChatSelection | null => {
    const saved = read().selection;

    if (saved) return saved;

    for (const provider of available()) {
      const model = provider.models.find((item) => item.id === "gpt-6-luna");

      if (model)
        return {
          providerId: provider.config.id,
          modelId: model.id,
          options: {},
        };
    }

    return null;
  };
  const validate = (value: ChatSelection) => {
    const provider = available().find(
      (item) => item.config.id === value.providerId,
    );

    if (!provider?.models.some((model) => model.id === value.modelId))
      throw new Error(
        "Choose an available Codex or Claude model in Settings → Chat.",
      );

    return provider;
  };
  const configure = Effect.fn("TextGenerationService.configure")(
    (input: unknown) =>
      Effect.try(() => {
        const value = Schema.decodeUnknownSync(TextGenerationSettings)(input);

        if (value.selection) validate(value.selection);

        db.prepare("INSERT OR REPLACE INTO settings VALUES (1, ?)").run(
          JSON.stringify(value),
        );

        return read();
      }),
  );
  const generate = Effect.fn("TextGenerationService.generate")(
    (prompt: string, signal: AbortSignal) =>
      Effect.tryPromise(async () => {
        const selected = selection();

        if (!selected)
          throw new Error("Choose a text generation model in Settings → Chat.");

        const provider = validate(selected);
        const launch = providerLaunch(
          provider.config,
          root,
          AbortSignal.any([
            shutdown.signal,
            signal,
            AbortSignal.timeout(120_000),
          ]),
          providers.environment(provider.config.id),
        );
        const text = await (
          provider.config.driver === "codex"
            ? generateCodexText
            : generateClaudeText
        )(launch, {
          model: selected.modelId,
          prompt,
          schema: {
            type: "object",
            properties: {
              role: { type: "string" },
              description: { type: "string" },
            },
            required: ["role", "description"],
            additionalProperties: false,
          },
        });

        return Schema.decodeUnknownSync(AgentProfile)(JSON.parse(text.trim()));
      }),
  );

  return {
    read,
    selection,
    configure,
    generate,
    close() {
      shutdown.abort();
      db.close();
    },
  };
}
