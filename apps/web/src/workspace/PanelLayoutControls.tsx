import { Button } from "../components/ui/button.tsx";
// Adapted from T3 Code chat/PanelLayoutControls.tsx (MIT).
import {
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomIcon,
  PanelRightIcon,
} from "lucide-react";

interface PanelLayoutControlsProps {
  terminalOpen: boolean;
  rightPanelOpen: boolean;
  maximized: boolean;
  showMaximize: boolean;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
  onToggleMaximized: () => void;
}

export function PanelLayoutControls(props: PanelLayoutControlsProps) {
  return (
    <div className="panel-layout-controls">
      {props.rightPanelOpen && props.showMaximize && (
        <Button
          type="button"
          className="sidebar-icon-button"
          title={props.maximized ? "Restore panel size" : "Maximize panel"}
          aria-label={props.maximized ? "Restore panel size" : "Maximize panel"}
          aria-pressed={props.maximized}
          onClick={props.onToggleMaximized}
        >
          {props.maximized ? (
            <Minimize2Icon aria-hidden />
          ) : (
            <Maximize2Icon aria-hidden />
          )}
        </Button>
      )}
      <Button
        type="button"
        className="sidebar-icon-button"
        title="Toggle terminal drawer"
        aria-label="Toggle terminal drawer"
        aria-pressed={props.terminalOpen}
        aria-controls="workspace-bottom"
        onClick={props.onToggleTerminal}
      >
        <PanelBottomIcon aria-hidden />
      </Button>
      <Button
        type="button"
        className="sidebar-icon-button"
        title="Toggle right panel"
        aria-label="Toggle right panel"
        aria-pressed={props.rightPanelOpen}
        aria-controls="workspace-sidebar"
        onClick={props.onToggleRightPanel}
      >
        <PanelRightIcon aria-hidden />
      </Button>
    </div>
  );
}
