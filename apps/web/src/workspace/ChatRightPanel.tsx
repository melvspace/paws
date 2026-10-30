import { Button } from "../components/ui/button.tsx";
// Adapted from T3 Code ChatRightPanel, RightPanelSheet, and RightPanelTabs (MIT).
import { type CSSProperties, type ReactNode } from "react";
import { Dialog, DialogPopup } from "../components/ui/dialog.tsx";
import { FolderIcon, XIcon } from "lucide-react";
import { usePanelSize } from "./hooks/usePanelSize.ts";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  panelMaxWidth,
} from "./layout.ts";

interface ChatRightPanelProps {
  agentId: string;
  open: boolean;
  maximized: boolean;
  sheet: boolean;
  rowWidth: number;
  viewportWidth: number;
  controls: ReactNode;
  onClose: () => void;
}

export function ChatRightPanel(props: ChatRightPanelProps) {
  const max = panelMaxWidth(props.viewportWidth, props.rowWidth);
  const { size, handle } = usePanelSize({
    storageKey: `paws.panel-width.${props.agentId}`,
    defaultSize: PANEL_DEFAULT_WIDTH,
    min: PANEL_MIN_WIDTH,
    max,
    axis: "x",
  });

  const content = (
    <>
      <div className="right-panel-tabbar">
        <div className="right-panel-tab">
          <FolderIcon size={14} aria-hidden />
          <span>Files</span>
        </div>
        {props.controls}
        {props.sheet && (
          <Button
            type="button"
            className="sidebar-icon-button"
            aria-label="Close right panel"
            onClick={props.onClose}
          >
            <XIcon aria-hidden />
          </Button>
        )}
      </div>
      <div className="panel-placeholder">
        <FolderIcon size={24} aria-hidden />
        <p>File browser not connected</p>
      </div>
    </>
  );

  if (props.sheet) {
    return (
      <Dialog
        open={props.open}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <DialogPopup
          sheet
          id="workspace-sidebar"
          className="right-panel-sheet"
          aria-label="Workspace files"
        >
          {content}
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <aside
      id="workspace-sidebar"
      className="workspace-sidebar"
      aria-label="Workspace files"
      hidden={!props.open}
      data-maximized={props.maximized}
      style={{ "--panel-size": `${size}px` } as CSSProperties}
    >
      {!props.maximized && (
        <div
          className="panel-resize-handle panel-resize-width"
          role="separator"
          tabIndex={0}
          aria-label="Resize right panel"
          aria-orientation="vertical"
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuemax={max}
          aria-valuenow={size}
          {...handle}
        />
      )}
      {content}
    </aside>
  );
}
