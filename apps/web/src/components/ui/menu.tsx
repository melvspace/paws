// Adapted from T3 Code ui/menu.tsx (MIT); see LICENSE.
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "../../lib/utils.ts";

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuGroup = MenuPrimitive.Group;
export const MenuRadioGroup = MenuPrimitive.RadioGroup;

export function MenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      data-variant={variant}
      className={(state) =>
        cn(
          "ui-menu-item",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export function MenuRadioItem({
  className,
  ...props
}: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="menu-radio-item"
      className={(state) =>
        cn(
          "ui-menu-radio-item",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export function MenuGroupLabel({
  className,
  ...props
}: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="menu-label"
      className={(state) =>
        cn(
          "ui-menu-label",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export function MenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={(state) =>
        cn(
          "ui-menu-separator",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export function MenuPopup({
  className,
  side = "top",
  align = "end",
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props & {
  side?: MenuPrimitive.Positioner.Props["side"];
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className="ui-popover-positioner"
      >
        <MenuPrimitive.Popup
          data-slot="menu-popup"
          className={(state) =>
            cn(
              "ui-menu-popup",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}
