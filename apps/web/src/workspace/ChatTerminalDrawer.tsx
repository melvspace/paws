import { Button } from "../components/ui/button.tsx";
// Adapted from T3 Code ThreadTerminalDrawer sizing and resize surface (MIT).
import type { CSSProperties } from "react";
import { TerminalIcon, XIcon } from "lucide-react";
import { usePanelSize } from "./hooks/usePanelSize.ts";
import { TERMINAL_DEFAULT_HEIGHT, terminalMaxHeight } from "./layout.ts";

interface ChatTerminalDrawerProps {
  agentId: string;
  open: boolean;
  columnHeight: number;
  viewportHeight: number;
  onClose: () => void;
}

export function ChatTerminalDrawer(props: ChatTerminalDrawerProps) {
  const max = terminalMaxHeight(props.viewportHeight, props.columnHeight);
  const { size, handle } = usePanelSize({
    storageKey: `paws.terminal-height.${props.agentId}`,
    defaultSize: TERMINAL_DEFAULT_HEIGHT,
    min: 180,
    max,
    axis: "y",
  });

  return (
    <section
      className="workspace-bottom"
      id="workspace-bottom"
      aria-label="Terminal"
      hidden={!props.open}
      style={{ "--panel-size": `${size}px` } as CSSProperties}
    >
      <div
        className="panel-resize-handle panel-resize-height"
        role="separator"
        tabIndex={0}
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        aria-valuemin={Math.min(180, max)}
        aria-valuemax={max}
        aria-valuenow={size}
        {...handle}
      />
      <div className="terminal-actionbar">
        <span>
          <TerminalIcon size={14} aria-hidden />
          Terminal
        </span>
        <Button
          className="sidebar-icon-button"
          type="button"
          aria-label="Close terminal drawer"
          onClick={props.onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      <div className="terminal-content">
        <p>Terminal not connected</p>
      </div>
    </section>
  );
}
