// Adapted from T3 Code ProviderModelsSection (MIT).
import { useState } from "react";
import "./providers.css";
import { Switch } from "@base-ui/react/switch";
import { ArrowDownIcon, ArrowUpIcon, StarIcon } from "lucide-react";
import { modelKey } from "@paws/provider-core";
import type { ProviderModel, ProviderSnapshot } from "@paws/contracts";
import { useModelPreferences } from "../workspace/modelPreferences.ts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";

function capabilities(model: ProviderModel) {
  const labels: string[] = [];

  if (
    model.options.some(
      (option) =>
        option.id === "fastMode" ||
        (option.id === "serviceTier" &&
          option.choices.some((choice) => choice.label === "Fast")),
    )
  )
    labels.push("Fast mode");
  if (model.options.some((option) => option.id === "thinking"))
    labels.push("Thinking");
  if (
    model.options.some((option) =>
      [
        "reasoningEffort",
        "effort",
        "reasoning",
        "thinkingLevel",
        "variant",
      ].includes(option.id),
    )
  )
    labels.push("Reasoning");

  return labels.join(" · ");
}

export function ProviderModels({ provider }: { provider: ProviderSnapshot }) {
  const preferences = useModelPreferences();
  const [filter, setFilter] = useState("");
  const key = (id: string) => modelKey(provider.config.id, id);
  const group = (id: string) =>
    preferences.hidden.includes(key(id))
      ? 2
      : preferences.favorites.includes(key(id))
        ? 0
        : 1;
  const rank = (id: string) => {
    const index = preferences.order.indexOf(key(id));

    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const models = [...provider.models].sort(
    (a, b) => group(a.id) - group(b.id) || rank(a.id) - rank(b.id),
  );
  const visible = models.filter((model) =>
    `${model.name} ${model.id}`
      .toLowerCase()
      .includes(filter.toLowerCase().trim()),
  );
  const hiddenCount = models.filter((model) =>
    preferences.hidden.includes(key(model.id)),
  ).length;
  const favoriteCount = models.filter((model) =>
    preferences.favorites.includes(key(model.id)),
  ).length;
  const allHidden = models.length > 0 && hiddenCount === models.length;

  function move(index: number, direction: -1 | 1) {
    const next = models.map((model) => key(model.id));
    const other = index + direction;
    [next[index], next[other]] = [next[other]!, next[index]!];
    preferences.setOrder([
      ...preferences.order.filter((id) => !next.includes(id)),
      ...next,
    ]);
  }

  return (
    <section className="provider-model-section" aria-label="Provider models">
      <h4 className="provider-section-title">Models</h4>
      <div className="provider-models-toolbar">
        {models.length > 8 && (
          <Input
            aria-label="Filter models"
            placeholder="Filter models"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        {models.length > 0 && (
          <Button
            variant="ghost"
            onClick={() => {
              const keys = models.map((model) => key(model.id));
              preferences.setHidden(
                allHidden
                  ? preferences.hidden.filter((id) => !keys.includes(id))
                  : [...new Set([...preferences.hidden, ...keys])],
              );
            }}
          >
            {allHidden ? "Enable all" : "Disable all"}
          </Button>
        )}
        <span>
          {models.length} {models.length === 1 ? "model" : "models"}
          {favoriteCount ? ` · ${favoriteCount} favorites` : ""}
          {hiddenCount ? ` · ${hiddenCount} hidden` : ""}
        </span>
      </div>
      <div className="provider-models">
        {visible.map((model, index) => {
          const hidden = preferences.hidden.includes(key(model.id));
          const favorite = preferences.favorites.includes(key(model.id));
          const startsGroup =
            index === 0 || group(visible[index - 1]!.id) !== group(model.id);
          const modelIndex = models.indexOf(model);

          return (
            <div key={model.id}>
              {startsGroup && (hidden || favoriteCount > 0) && (
                <h5>
                  {hidden
                    ? "Hidden from picker"
                    : favorite
                      ? "Favorites"
                      : "All"}
                </h5>
              )}
              <div className="provider-model-row" data-hidden={hidden}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${favorite ? "Remove" : "Add"} ${model.name} ${favorite ? "from" : "to"} favorites`}
                  aria-pressed={favorite}
                  onClick={() => preferences.toggleFavorite(key(model.id))}
                >
                  <StarIcon
                    size={14}
                    fill={favorite ? "currentColor" : "none"}
                  />
                </Button>
                <span className="provider-model-name" title={model.id}>
                  {model.name}
                </span>
                <span className="provider-model-traits">
                  {capabilities(model)}
                </span>
                <div className="provider-model-order">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${model.name} up`}
                    disabled={
                      !!filter ||
                      modelIndex === 0 ||
                      group(models[modelIndex - 1]!.id) !== group(model.id)
                    }
                    onClick={() => move(modelIndex, -1)}
                  >
                    <ArrowUpIcon size={12} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${model.name} down`}
                    disabled={
                      !!filter ||
                      modelIndex === models.length - 1 ||
                      group(models[modelIndex + 1]!.id) !== group(model.id)
                    }
                    onClick={() => move(modelIndex, 1)}
                  >
                    <ArrowDownIcon size={12} />
                  </Button>
                </div>
                <Switch.Root
                  className="provider-switch"
                  aria-label={`Show ${model.name} in picker`}
                  checked={!hidden}
                  onCheckedChange={(show) =>
                    preferences.setHidden(
                      show
                        ? preferences.hidden.filter(
                            (id) => id !== key(model.id),
                          )
                        : [...preferences.hidden, key(model.id)],
                    )
                  }
                >
                  <Switch.Thumb className="provider-switch-thumb" />
                </Switch.Root>
              </div>
            </div>
          );
        })}
        {!visible.length && (
          <p className="provider-note">
            {filter
              ? "No models match."
              : "No models reported for this provider yet."}
          </p>
        )}
      </div>
    </section>
  );
}
