// Adapted from T3 Code ui/button.tsx (MIT).
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./tooltip.tsx";
import { cn } from "../../lib/utils.ts";

const buttonVariants = cva("ui-button", {
  variants: {
    variant: {
      default: "",
      secondary: "secondary",
      ghost: "ui-button-ghost",
      destructive: "ui-button-destructive",
      outline: "ui-button-outline",
    },
    size: { default: "", icon: "sidebar-icon-button" },
  },
});

type ButtonProps = useRender.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants>;

export function Button({
  render,
  className,
  variant,
  size,
  type = "button",
  title,
  ...props
}: ButtonProps) {
  const element = useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(
      { type, className: cn(buttonVariants({ variant, size }), className) },
      props,
    ),
  });

  return title ? (
    <Tooltip>
      <TooltipTrigger render={element} />
      <TooltipPopup>{title}</TooltipPopup>
    </Tooltip>
  ) : (
    element
  );
}
