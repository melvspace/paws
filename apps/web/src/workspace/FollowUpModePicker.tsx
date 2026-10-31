import { ChevronDownIcon } from "lucide-react";
import type { FollowUpMode } from "@paws/contracts";
import { Button } from "../components/ui/button.tsx";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../components/ui/menu.tsx";

export function FollowUpModePicker({
  value,
  onChange,
}: {
  value: FollowUpMode;
  onChange: (mode: FollowUpMode) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="outline" />}
        aria-label="Follow-up behavior"
      >
        {value === "steer" ? "Steer" : "Queue"}
        <ChevronDownIcon size={14} aria-hidden />
      </MenuTrigger>
      <MenuPopup aria-label="Follow-up behavior">
        <MenuRadioGroup
          value={value}
          onValueChange={(mode) => {
            if (mode === "steer" || mode === "queue") onChange(mode);
          }}
        >
          <MenuRadioItem
            value="steer"
            className="ui-menu-radio-item"
            closeOnClick
          >
            Steer current turn
          </MenuRadioItem>
          <MenuRadioItem
            value="queue"
            className="ui-menu-radio-item"
            closeOnClick
          >
            Queue for next turn
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
