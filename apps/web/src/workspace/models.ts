import type { ProviderModel, ProviderSnapshot } from "@paws/contracts";
import { modelKey } from "@paws/provider-core";

export interface ModelOption extends ProviderModel {
  nativeId: string;
  shortName: string;
  provider: string;
  driver: ProviderSnapshot["config"]["driver"];
  providerName: string;
}

export function availableModels(
  providers: readonly ProviderSnapshot[],
): ModelOption[] {
  return providers
    .filter(
      (provider) => provider.config.enabled && provider.status === "ready",
    )
    .flatMap((provider) =>
      provider.models.map((model) => ({
        ...model,
        nativeId: model.id,
        id: modelKey(provider.config.id, model.id),
        shortName: model.name.replace(/^(GPT-|Claude |Gemini )/, ""),
        provider: provider.config.id,
        driver: provider.config.driver,
        providerName: provider.config.name,
      })),
    );
}

export const favoritesStorageKey = "paws.model-favorites";

export function readModelFavorites(
  storage: Pick<Storage, "getItem">,
): string[] {
  try {
    const saved: unknown = JSON.parse(
      storage.getItem(favoritesStorageKey) ?? "null",
    );

    if (Array.isArray(saved)) {
      return [
        ...new Set(
          saved
            .filter((id): id is string => typeof id === "string")
            .map((id) => (id.includes(":") ? id : modelKey("codex", id))),
        ),
      ];
    }
  } catch {
    // Storage can be unavailable; browsing the catalog must still work.
  }

  return [];
}

export function filterModels(
  models: readonly ModelOption[],
  query: string,
  tab: string,
  favorites: readonly string[],
): ModelOption[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  return models.filter((model) => {
    if (tokens.length > 0) {
      const text =
        `${model.name} ${model.shortName} ${model.providerName}`.toLowerCase();

      return tokens.every((token) => text.includes(token));
    }

    return (
      tab === "all" ||
      (tab === "favorites"
        ? favorites.includes(model.id)
        : model.provider === tab)
    );
  });
}
