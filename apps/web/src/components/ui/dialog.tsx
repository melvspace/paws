// Adapted from T3 Code ui/dialog.tsx and AppRouteModal.tsx (MIT).
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "../../lib/utils.ts";

export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

export function DialogPopup({
  className,
  sheet = false,
  ...props
}: DialogPrimitive.Popup.Props & { sheet?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop forceRender className="ui-dialog-backdrop" />
      <DialogPrimitive.Viewport
        className={cn("ui-dialog-viewport", sheet && "ui-sheet-viewport")}
      >
        <DialogPrimitive.Popup
          data-slot="dialog-popup"
          className={cn("ui-dialog-popup", className)}
          {...props}
        />
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}
