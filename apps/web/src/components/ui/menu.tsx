// Adapted from T3 Code ui/menu.tsx (MIT); see LICENSE.t3code.
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "../../lib/utils.ts";

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuSeparator = MenuPrimitive.Separator;
export const MenuGroup = MenuPrimitive.Group;
export const MenuGroupLabel = MenuPrimitive.GroupLabel;
export const MenuRadioGroup = MenuPrimitive.RadioGroup;
export const MenuRadioItem = MenuPrimitive.RadioItem;

export function MenuPopup({ className, ...props }: MenuPrimitive.Popup.Props) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="ui-popover-positioner"
      >
        <MenuPrimitive.Popup
          className={cn("ui-menu-popup", className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}
