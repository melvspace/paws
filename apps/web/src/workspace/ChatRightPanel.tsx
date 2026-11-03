import { FloatingBrowser } from "./FloatingBrowser.tsx";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { Button } from "../components/ui/button.tsx";
// Adapted from T3 Code ChatRightPanel, RightPanelSheet, and RightPanelTabs (MIT).
import {
  useCallback,
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Dialog, DialogPopup } from "../components/ui/dialog.tsx";
import { PlusIcon, SettingsIcon, GlobeIcon, XIcon } from "lucide-react";
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
  browserOpen?: boolean;
  browserReveal?: number;
  onTabChange?: (tab: "settings" | "browser") => void;
  onTabClose?: (tab: "settings" | "browser") => Promise<boolean>;
}

export function ChatRightPanel(props: ChatRightPanelProps) {
  const tabId = useId();
  // Reparent one portal host so responsive containers never remount its editors.
  const [contentHost] = useState(() => {
    const host = document.createElement("div");
    host.className = "right-panel-body";

    return host;
  });
  const attachContent = useCallback(
    (host: HTMLDivElement | null) => {
      host?.append(contentHost);
    },
    [contentHost],
  );
  const [selectedTab, setSelectedTab] = useState<"settings" | "browser">(
    "settings",
  );
  const hasSettings = !!props.children;

  useEffect(() => {
    if (hasSettings) setSelectedTab("settings");
  }, [hasSettings]);

  useEffect(() => {
    if (props.browserOpen) setSelectedTab("browser");
  }, [props.browserOpen, props.browserReveal]);

  const activeTab =
    selectedTab === "browser" && props.browserOpen
      ? "browser"
      : hasSettings
        ? "settings"
        : props.browserOpen
          ? "browser"
          : null;
  const floating = !!props.browserOpen && !props.open;
  const [browserHost] = useState(() => {
    const host = document.createElement("div");
    host.className = "browser-view-host";

    return host;
  });
  const attachBrowser = useCallback(
    (host: HTMLDivElement | null) => {
      host?.append(browserHost);
    },
    [browserHost],
  );
  const tabs: readonly ("settings" | "browser")[] = [
    ...(props.children ? ["settings" as const] : []),
    ...(props.browserOpen ? ["browser" as const] : []),
  ];
  const availableTabs = (["settings", "browser"] as const).filter(
    (tab) => !tabs.includes(tab),
  );
  const panels = {
    browser: { label: "Browser", Icon: GlobeIcon },
    settings: { label: "Agent settings", Icon: SettingsIcon },
  };

  function selectTab(tab: "settings" | "browser") {
    setSelectedTab(tab);
    props.onTabChange?.(tab);
  }

  async function closeTab(tab: "settings" | "browser") {
    await props.onTabClose?.(tab);
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
            if (
              !(event.target instanceof HTMLElement) ||
              event.target.getAttribute("role") !== "tab"
            )
              return;

            const index = activeTab ? tabs.indexOf(activeTab) : -1;
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
              <div
                key={tab}
                className="right-panel-tab-item"
                data-active={activeTab === tab || undefined}
              >
                <Button
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
                <Button
                  type="button"
                  variant="ghost"
                  className="right-panel-tab-close"
                  aria-label={`Close ${label} tab`}
                  onClick={() => void closeTab(tab)}
                >
                  <XIcon size={12} aria-hidden />
                </Button>
              </div>
            );
          })}
        </div>
        {props.onTabChange && (
          <Menu.Root>
            <Menu.Trigger
              render={<Button className="sidebar-icon-button" />}
              aria-label="Add sidebar tab"
              title="Add tab"
              disabled={availableTabs.length === 0}
            >
              <PlusIcon size={16} aria-hidden />
            </Menu.Trigger>
            <MenuPopup aria-label="Add sidebar tab">
              {availableTabs.map((tab) => {
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
        role={activeTab ? "tabpanel" : undefined}
        aria-labelledby={activeTab ? `${tabId}-${activeTab}` : undefined}
      >
        <div className="right-panel-settings" hidden={activeTab !== "settings"}>
          {props.children}
        </div>
        {!floating && props.browserOpen && (
          <div
            hidden={activeTab !== "browser"}
            className="browser-view-host"
            ref={attachBrowser}
          />
        )}
        {!activeTab && (
          <div className="surface-picker" aria-label="Open a surface">
            <h2>Open a surface</h2>
            {props.onTabChange && (
              <Button
                variant="ghost"
                className="surface-picker-option"
                onClick={() => selectTab("browser")}
              >
                <GlobeIcon size={20} aria-hidden />
                <span>Browser</span>
              </Button>
            )}
            {props.onTabChange && (
              <Button
                variant="ghost"
                className="surface-picker-option"
                onClick={() => selectTab("settings")}
              >
                <SettingsIcon size={20} aria-hidden />
                <span>Agent settings</span>
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );

  return (
    <Dialog
      open={props.sheet && props.open}
      onOpenChange={(open, details) => {
        if (!open && props.sheet) {
          details.cancel();
          props.onClose();
        }
      }}
    >
      {createPortal(content, contentHost)}
      {props.browserOpen &&
        createPortal(
          <BrowserPanel
            agentId={props.agentId}
            compact={floating}
            active={floating || (props.open && activeTab === "browser")}
          />,
          browserHost,
        )}
      {floating && (
        <FloatingBrowser
          agentId={props.agentId}
          onDock={() => selectTab("browser")}
          onClose={() => void closeTab("browser")}
        >
          <div className="browser-view-host" ref={attachBrowser} />
        </FloatingBrowser>
      )}
      {props.sheet ? (
        <DialogPopup
          sheet
          id="workspace-sidebar"
          className="right-panel-sheet"
          aria-label={
            activeTab ? panels[activeTab].label : "Workspace surfaces"
          }
        >
          <div className="right-panel-body" ref={attachContent} />
        </DialogPopup>
      ) : (
        <aside
          id="workspace-sidebar"
          className="workspace-sidebar"
          aria-label={
            activeTab ? panels[activeTab].label : "Workspace surfaces"
          }
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
          <div className="right-panel-body" ref={attachContent} />
        </aside>
      )}
    </Dialog>
  );
}
