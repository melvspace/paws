// Adapted from T3 Code ui/checkbox.tsx (MIT); see LICENSE.
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "../../lib/utils.ts";

export function Checkbox({
  className,
  ...props
}: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      className={cn("ui-checkbox", className)}
      data-slot="checkbox"
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="ui-checkbox-indicator"
        data-slot="checkbox-indicator"
        render={(indicatorProps, state) => (
          <span {...indicatorProps}>
            <svg
              fill="none"
              height="24"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="3"
              viewBox="0 0 24 24"
              width="24"
              aria-hidden
            >
              <path
                d={
                  state.indeterminate
                    ? "M5.252 12h13.496"
                    : "M5.252 12.7 10.2 18.63 18.748 5.37"
                }
              />
            </svg>
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}
