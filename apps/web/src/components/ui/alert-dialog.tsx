// Adapted from T3 Code ui/alert-dialog.tsx (MIT); see LICENSE.
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTitle = AlertDialogPrimitive.Title;
export const AlertDialogDescription = AlertDialogPrimitive.Description;

export function AlertDialogPopup({
  className,
  ...props
}: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        forceRender
        className="ui-dialog-backdrop"
      />
      <AlertDialogPrimitive.Viewport className="ui-dialog-viewport">
        <AlertDialogPrimitive.Popup
          className={cn("ui-dialog-popup ui-alert-dialog", className)}
          {...props}
        />
      </AlertDialogPrimitive.Viewport>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({
  className,
  ...props
}: ComponentProps<"div">) {
  return <div className={cn("ui-alert-dialog-header", className)} {...props} />;
}

export function AlertDialogFooter({
  className,
  ...props
}: ComponentProps<"div">) {
  return <div className={cn("ui-alert-dialog-footer", className)} {...props} />;
}
