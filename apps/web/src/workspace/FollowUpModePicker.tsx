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
          <MenuRadioItem value="steer" closeOnClick>
            Steer current turn
          </MenuRadioItem>
          <MenuRadioItem value="queue" closeOnClick>
            Queue for next turn
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
