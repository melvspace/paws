// Descriptor-driven traits menu, adapted from T3 Code TraitsPicker (MIT).
import { GaugeIcon, ZapIcon } from "lucide-react";
import type { ProviderModel } from "@paws/contracts";
import { normalizeModelOptions } from "@paws/provider-core";
import { ComposerControl } from "./ComposerControl.tsx";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuSeparator,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
} from "../components/ui/menu.tsx";
import { Fragment } from "react";

interface ReasoningPickerProps {
  model: ProviderModel | undefined;
  value: Readonly<Record<string, string>>;
  onChange: (value: Record<string, string>) => void;
}

export function ReasoningPicker({
  model,
  value,
  onChange,
}: ReasoningPickerProps) {
  if (!model?.options.length) return null;

  const selected = normalizeModelOptions(model, value);
  const primary = model.options.find(
    (option) => !["serviceTier", "fastMode"].includes(option.id),
  );
  const label = primary?.choices.find(
    (choice) => choice.id === selected[primary.id],
  )?.label;
  const fast =
    selected.fastMode === "true" ||
    ["fast", "priority", "ultrafast"].includes(selected.serviceTier ?? "");
  const title = primary
    ? `${primary.label}: ${label}${fast ? ", Fast" : ""}`
    : fast
      ? "Service Tier: Fast"
      : "Model options";

  return (
    <Menu>
      <MenuTrigger
        render={<ComposerControl className="reasoning-picker-trigger" />}
        aria-label={title}
      >
        {label ?? (fast ? "Fast" : <GaugeIcon aria-hidden />)}
        {fast && <ZapIcon aria-hidden fill="currentColor" />}
      </MenuTrigger>
      <MenuPopup aria-label="Model options">
        {model.options.map((option, index) => (
          <Fragment key={option.id}>
            {index > 0 && <MenuSeparator className="ui-menu-separator" />}
            <MenuGroup>
              <MenuGroupLabel className="ui-menu-label">
                {option.label}
              </MenuGroupLabel>
              <MenuRadioGroup
                value={selected[option.id]}
                onValueChange={(next) => {
                  if (
                    typeof next === "string" &&
                    option.choices.some((choice) => choice.id === next)
                  ) {
                    onChange({ ...selected, [option.id]: next });
                  }
                }}
              >
                {option.choices.map((choice) => (
                  <MenuRadioItem
                    key={choice.id}
                    value={choice.id}
                    className="ui-menu-radio-item"
                    closeOnClick
                  >
                    {choice.label}
                    {choice.id === option.defaultValue && (
                      <span className="ui-menu-default-badge">Default</span>
                    )}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
}
