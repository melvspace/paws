import { ComposerControl } from "./ComposerControl.tsx";
import { Button } from "../components/ui/button.tsx";
// Adapted from T3 Code ProviderModelPicker, ModelPickerContent, and ModelListRow (MIT).
import { useEffect, useRef, useState } from "react";
import {
  Combobox,
  ComboboxInput,
  ComboboxList,
  ComboboxItem,
} from "../components/ui/combobox.tsx";
import {
  Popover,
  PopoverTrigger,
  PopoverPopup,
} from "../components/ui/popover.tsx";
import {
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
} from "../components/ui/tooltip.tsx";
import { CheckIcon, SearchIcon, StarIcon } from "lucide-react";
import { ProviderIcon } from "../providers/ProviderIcon.tsx";
import { LayersIcon, SettingsIcon } from "lucide-react";
import { filterModels, type ModelOption } from "./models.ts";
import { useModelPreferences } from "./modelPreferences.ts";
import "./model-picker.css";

interface ModelPickerProps {
  value: string;
  models: readonly ModelOption[];
  onSettings?: () => void;
  onChange: (model: string) => void;
}

export function ModelPicker({
  value,
  onChange,
  models: modelOptions,
  onSettings,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const { favorites, hidden, order, toggleFavorite } = useModelPreferences();
  const pickerModels = modelOptions
    .filter((model) => !hidden.includes(model.id))
    .sort((a, b) => {
      const rank = (id: string) => {
        const index = order.indexOf(id);

        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };

      return rank(a.id) - rank(b.id);
    });
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const providers = [
    ...new Map(modelOptions.map((model) => [model.provider, model])).values(),
  ];
  const current = modelOptions.find((model) => model.id === value);
  const visible = filterModels(pickerModels, query, tab, favorites);

  function changeOpen(next: boolean) {
    setOpen(next);

    if (next) {
      setQuery("");
    }
  }

  function select(model: string) {
    onChange(model);
    setOpen(false);
  }

  // Only the mounted, visible agent composer owns these shortcuts.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        !(event.ctrlKey || event.metaKey) ||
        !triggerRef.current?.getClientRects().length ||
        document.querySelector('[data-slot="dialog-popup"]')
      ) {
        return;
      }

      if (event.shiftKey && event.code === "KeyM") {
        event.preventDefault();
        changeOpen(!open);
      } else if (open && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const model = visible[Number(event.key) - 1];

        if (model) {
          event.preventDefault();
          select(model.id);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <Tooltip>
        <TooltipTrigger
          render={<PopoverTrigger render={<ComposerControl />} />}
          ref={triggerRef}
          className="model-picker-trigger"
          aria-label={`Choose model: ${current?.name ?? (value ? "Unavailable model" : "Select model")}`}
          aria-keyshortcuts="Control+Shift+M Meta+Shift+M"
        >
          <ProviderIcon driver={current?.driver} />
          <span>
            {current?.shortName ??
              (value ? "Unavailable model" : "Select model")}
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {current?.name ?? (value ? "Unavailable model" : "Select model")} ·
          Ctrl+Shift+M
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        className="model-picker-popup"
        initialFocus={searchRef}
        aria-label="Choose model"
      >
        <nav className="model-picker-sidebar" aria-label="Model providers">
          <Button
            aria-label="All models"
            title="All models"
            aria-pressed={tab === "all"}
            onClick={() => {
              setTab("all");
              setQuery("");
              searchRef.current?.focus();
            }}
          >
            <LayersIcon />
          </Button>
          <Button
            type="button"
            aria-label="Favorites"
            title="Favorites"
            aria-pressed={tab === "favorites"}
            onClick={() => {
              setTab("favorites");
              setQuery("");
              searchRef.current?.focus();
            }}
          >
            <StarIcon fill="currentColor" />
          </Button>
          <div className="model-picker-divider" />
          {providers.map((provider) => (
            <Button
              key={provider.provider}
              type="button"
              aria-label={`${provider.providerName} models`}
              title={provider.providerName}
              aria-pressed={tab === provider.provider}
              onClick={() => {
                setTab(provider.provider);
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <ProviderIcon driver={provider.driver} />
            </Button>
          ))}
          {onSettings && (
            <Button
              className="model-picker-settings"
              aria-label="Provider settings"
              title="Provider settings"
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              <SettingsIcon />
            </Button>
          )}
        </nav>
        <Combobox
          inline
          open
          autoHighlight
          items={modelOptions.map((model) => model.id)}
          filteredItems={visible.map((model) => model.id)}
          filter={null}
          value={value}
          onValueChange={(id) => {
            if (id) select(id);
          }}
        >
          <div className="model-picker-main">
            <div className="model-picker-search">
              <SearchIcon size={18} aria-hidden />
              <ComboboxInput
                ref={searchRef}
                aria-label="Search models"
                placeholder="Search models…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;

                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                  }
                }}
              />
            </div>
            <ComboboxList className="model-picker-list">
              {visible.map((model, index) => (
                <ComboboxItem
                  key={model.id}
                  value={model.id}
                  className="model-picker-row"
                >
                  <div className="model-picker-label">
                    <span>{model.name}</span>
                    <span className="model-picker-provider">
                      <ProviderIcon driver={model.driver} />
                      {model.providerName}
                    </span>
                  </div>
                  {index < 9 && <kbd>Ctrl+{index + 1}</kbd>}
                  <Button
                    type="button"
                    className="model-favorite"
                    aria-label={`${favorites.includes(model.id) ? "Unfavorite" : "Favorite"} ${model.name}`}
                    aria-pressed={favorites.includes(model.id)}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFavorite(model.id);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <StarIcon
                      size={15}
                      fill={
                        favorites.includes(model.id) ? "currentColor" : "none"
                      }
                    />
                  </Button>
                  <CheckIcon
                    size={16}
                    aria-hidden
                    className={
                      value === model.id
                        ? "model-check"
                        : "model-check invisible"
                    }
                  />
                </ComboboxItem>
              ))}
            </ComboboxList>
            {visible.length === 0 && (
              <p className="model-picker-empty" role="status">
                {tab === "favorites" && !query.trim()
                  ? "No favorites yet"
                  : modelOptions.length
                    ? "No models found"
                    : "Enable a provider in Settings"}
              </p>
            )}
          </div>
        </Combobox>
      </PopoverPopup>
    </Popover>
  );
}
