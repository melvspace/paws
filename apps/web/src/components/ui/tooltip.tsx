import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

export const Tooltip = TooltipPrimitive.Root;
export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipPopup(props: TooltipPrimitive.Popup.Props) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        sideOffset={8}
        className="ui-tooltip-positioner"
      >
        <TooltipPrimitive.Popup className="ui-tooltip" {...props} />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
