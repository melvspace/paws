import type { ComponentProps, ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog.tsx";
import "./settings-dialog.css";

type PopupProps = ComponentProps<typeof DialogPopup>;

export function SettingsDialog({
  title,
  pending = false,
  dismissible = !pending,
  initialFocus,
  finalFocus,
  onDismiss,
  children,
  footer,
}: {
  title: string;
  pending?: boolean;
  dismissible?: boolean;
  initialFocus?: PopupProps["initialFocus"];
  finalFocus?: PopupProps["finalFocus"];
  onDismiss: () => void | Promise<void>;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (!open) {
          details.cancel();

          if (dismissible) void onDismiss();
        }
      }}
    >
      <DialogPopup
        className="settings-editor-dialog"
        initialFocus={initialFocus}
        finalFocus={finalFocus}
        aria-busy={pending}
      >
        <header className="settings-editor-heading">
          <DialogTitle>{title}</DialogTitle>
          <Button
            className="sidebar-icon-button"
            aria-label={`Close ${title.toLowerCase()}`}
            disabled={!dismissible}
            onMouseDown={(event) => {
              // Dismiss owns blurring so autosave cannot interrupt the close click.
              event.preventDefault();
            }}
            onClick={() => {
              void onDismiss();
            }}
          >
            <XIcon size={16} aria-hidden />
          </Button>
        </header>
        <div className="settings-editor-body">{children}</div>
        {footer && <footer className="settings-editor-footer">{footer}</footer>}
      </DialogPopup>
    </Dialog>
  );
}
