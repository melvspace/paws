import { Button } from "../components/ui/button.tsx";
// Adapted from T3 Code ChatRightPanel, RightPanelSheet, and RightPanelTabs (MIT).
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { Dialog, DialogPopup } from "../components/ui/dialog.tsx";
import { FolderIcon, PlusIcon, SettingsIcon, XIcon } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { MenuPopup } from "../components/ui/menu.tsx";
import "./workspace.css";
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
  children?: ReactNode;
  onTabChange?: (tab: "files" | "settings") => void;
}

export function ChatRightPanel(props: ChatRightPanelProps) {
  const tabId = useId();
  const activeTab: "files" | "settings" = props.children ? "settings" : "files";
  const [openedTabs, setOpenedTabs] = useState<
    readonly ("files" | "settings")[]
  >([activeTab]);
  const tabs = [...new Set([...openedTabs, activeTab])];
  const panels = {
    files: { label: "Files", Icon: FolderIcon },
    settings: { label: "Agent settings", Icon: SettingsIcon },
  };

  function selectTab(tab: "files" | "settings") {
    setOpenedTabs([...new Set([...tabs, tab])]);
    props.onTabChange?.(tab);
  }

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
        <div
          className="right-panel-tabs"
          role="tablist"
          aria-label="Sidebar tabs"
          onKeyDown={(event) => {
            const index = tabs.indexOf(activeTab);
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (index - 1 + tabs.length) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : undefined;

            if (next === undefined) return;

            event.preventDefault();
            const buttons =
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "[role=tab]",
              );
            buttons[next]?.focus();
            selectTab(tabs[next]!);
          }}
        >
          {tabs.map((tab) => {
            const { label, Icon } = panels[tab];

            return (
              <Button
                key={tab}
                id={`${tabId}-${tab}`}
                type="button"
                variant="ghost"
                className="right-panel-tab"
                role="tab"
                aria-selected={activeTab === tab}
                aria-controls={`${tabId}-content`}
                tabIndex={activeTab === tab ? 0 : -1}
                onClick={() => selectTab(tab)}
              >
                <Icon size={14} aria-hidden />
                <span>{label}</span>
              </Button>
            );
          })}
        </div>
        {props.onTabChange && (
          <Menu.Root>
            <Menu.Trigger
              render={<Button className="sidebar-icon-button" />}
              aria-label="Add sidebar tab"
              title="Add tab"
            >
              <PlusIcon size={16} aria-hidden />
            </Menu.Trigger>
            <MenuPopup aria-label="Add sidebar tab">
              {(["settings", "files"] as const).map((tab) => {
                const { label, Icon } = panels[tab];

                return (
                  <Menu.Item
                    key={tab}
                    className="ui-menu-radio-item"
                    onClick={() => selectTab(tab)}
                  >
                    <Icon size={14} aria-hidden />
                    {label}
                  </Menu.Item>
                );
              })}
            </MenuPopup>
          </Menu.Root>
        )}
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
      <div
        className="right-panel-content"
        id={`${tabId}-content`}
        role="tabpanel"
        aria-labelledby={`${tabId}-${activeTab}`}
      >
        {props.children || (
          <div className="panel-placeholder">
            <FolderIcon size={24} aria-hidden />
            <p>File browser not connected</p>
          </div>
        )}
      </div>
    </>
  );

  if (props.sheet) {
    return (
      <Dialog
        open={props.open}
        onOpenChange={(open, details) => {
          if (!open) {
            details.cancel();
            props.onClose();
          }
        }}
      >
        <DialogPopup
          sheet
          id="workspace-sidebar"
          className="right-panel-sheet"
          aria-label={props.children ? "Agent settings" : "Workspace files"}
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
      aria-label={props.children ? "Agent settings" : "Workspace files"}
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
