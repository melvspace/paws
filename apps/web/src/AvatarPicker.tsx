import {
  avatarAnimals,
  avatarColors,
  avatarColorNames,
  type AgentAvatar as Avatar,
} from "@paws/contracts";
import { CheckIcon } from "lucide-react";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { Button } from "./components/ui/button.tsx";

export function AvatarPicker({
  value,
  onChange,
  disabled,
}: {
  value: Avatar;
  onChange: (avatar: Avatar) => void;
  disabled: boolean;
}) {
  return (
    <section className="avatar-picker" aria-labelledby="avatar-heading">
      <div className="avatar-picker-heading">
        <AgentAvatar avatar={value} size={64} />
        <div>
          <h3 id="avatar-heading">Avatar</h3>
          <p>A familiar face for your agent.</p>
        </div>
      </div>
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
    </section>
  );
}
