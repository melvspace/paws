import {
  avatarAnimals,
  avatarColors,
  avatarColorNames,
  type AgentAvatar as Avatar,
} from "@paws/contracts";
import { CheckIcon, PencilIcon } from "lucide-react";
import { useState } from "react";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { Button } from "./components/ui/button.tsx";

export function AvatarPicker({
  value,
  onChange,
  disabled,
  compact = false,
}: {
  value: Avatar;
  onChange: (avatar: Avatar) => void;
  disabled: boolean;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section
      className="avatar-picker"
      aria-label="Avatar"
      data-expanded={!compact || expanded}
    >
      {compact ? (
        <Button
          type="button"
          variant="ghost"
          className="agent-avatar-edit"
          aria-label="Edit avatar"
          aria-expanded={expanded}
          disabled={disabled}
          onClick={() => setExpanded(!expanded)}
        >
          <AgentAvatar avatar={value} size={80} animated={false} />
          <span className="agent-avatar-edit-label" aria-hidden>
            <PencilIcon size={12} />
            Edit
          </span>
        </Button>
      ) : (
        <div className="avatar-picker-heading">
          <AgentAvatar avatar={value} size={64} />
          <div>
            <h3 id="avatar-heading">Avatar</h3>
            <p>A familiar face for your agent.</p>
          </div>
        </div>
      )}
      <div hidden={compact && !expanded}>
        <fieldset disabled={disabled}>
          <legend>Animal</legend>
          <div className="avatar-animal-options">
            {avatarAnimals.map((animal) => (
              <Button
                key={animal}
                variant="ghost"
                className="avatar-animal-option"
                aria-label={animal}
                aria-pressed={value.animal === animal}
                onClick={() => onChange({ ...value, animal })}
              >
                <AgentAvatar
                  avatar={{ ...value, animal }}
                  size={36}
                  animated={false}
                />
                <span>{animal}</span>
              </Button>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={disabled}>
          <legend>Color</legend>
          <div className="avatar-color-options">
            {avatarColorNames.map((color) => (
              <Button
                key={color}
                variant="ghost"
                className="avatar-color-option"
                aria-label={color}
                aria-pressed={value.color === color}
                style={{ backgroundColor: avatarColors[color] }}
                onClick={() => onChange({ ...value, color })}
              >
                {value.color === color && <CheckIcon size={18} aria-hidden />}
              </Button>
            ))}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
