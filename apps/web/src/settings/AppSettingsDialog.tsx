import { EnvironmentSettings } from "./EnvironmentSettings.tsx";
import { TeamsSettings } from "../TeamsSettings.tsx";
import { Input } from "../components/ui/input.tsx";
import { Button } from "../components/ui/button.tsx";
// Adapted from T3 Code AppRouteModal, SettingsContentLayout, and SettingsSidebarNav (MIT).
import { Fragment, useRef, useState } from "react";
import {
  PaintbrushIcon,
  PlugIcon,
  SearchIcon,
  XIcon,
  MessageSquareIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { ThemeSelect } from "../ThemeSelect.tsx";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogClose,
} from "../components/ui/dialog.tsx";
import "./settings.css";
import { ProviderSettings } from "./ProviderSettings.tsx";
import { ChatSettings } from "./ChatSettings.tsx";

export function AppSettingsDialog({
  onDismiss,
  initialPage = "Appearance",
  initialTeamId = null,
}: {
  onDismiss: () => void;
  initialTeamId?: string | null;
  initialPage?:
    | "Appearance"
    | "Chat"
    | "Providers"
    | "Teams"
    | "Environments"
    | "Sharing & access";
}) {
  const [page, setPage] = useState(initialPage);
  const beforeClose = useRef<(() => Promise<void>) | null>(null);
  const closing = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const pages = [
    {
      name: "Appearance" as const,
      keywords: "appearance color scheme theme system light dark",
      Icon: PaintbrushIcon,
    },
    {
      name: "Chat" as const,
      keywords:
        "chat text generation model luna profiles follow-ups queue steer running turn send default behavior composer",
      Icon: MessageSquareIcon,
    },
    {
      name: "Providers" as const,
      keywords:
        "providers models codex claude cursor grok fx opencode antigravity muse pi acp authentication",
      Icon: PlugIcon,
    },
    {
      name: "Environments" as const,
      keywords:
        "environments machines computers connections lan tailscale discovery pairing sharing",
      Icon: ServerIcon,
    },
    {
      name: "Sharing & access" as const,
      keywords:
        "sharing access permissions connections lan tailscale pairing security revoke",
      Icon: ShieldCheckIcon,
    },
  ].filter((item) => item.keywords.includes(query.trim().toLowerCase()));

  async function navigateTo(next: typeof page) {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();

    try {
      await beforeClose.current?.();
      setPage(next);
    } catch {
      // The active editor retains the failed change.
    }
  }

  async function dismiss() {
    if (closing.current) return;

    closing.current = true;

    try {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();

      await beforeClose.current?.();
      onDismiss();
    } catch {
      // The active settings editor keeps failed edits visible.
    } finally {
      closing.current = false;
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (!open) {
          details.cancel();
          void dismiss();
        }
      }}
    >
      <DialogPopup
        ref={dialogRef}
        className="app-settings-dialog"
        initialFocus={dialogRef}
      >
        <nav className="app-settings-nav" aria-label="Settings pages">
          <label className="settings-search">
            <SearchIcon size={16} aria-hidden />
            <Input
              type="search"
              aria-label="Search settings"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {pages.map(({ name, Icon }) => (
            <Fragment key={name}>
              {name === "Providers" && (
                <h3 className="settings-nav-section">Agents</h3>
              )}
              {(name === "Environments" ||
                (name === "Sharing & access" &&
                  !pages.some((item) => item.name === "Environments"))) && (
                <h3 className="settings-nav-section">Connections</h3>
              )}
              <Button
                className="settings-nav-item"
                aria-current={page === name ? "page" : undefined}
                onClick={() => {
                  void navigateTo(name);
                }}
              >
                <Icon size={16} aria-hidden />
                <span>{name}</span>
              </Button>
            </Fragment>
          ))}
          {!pages.length && (
            <p className="settings-search-empty" role="status">
              No settings found
            </p>
          )}
        </nav>
        <div className="app-settings-main">
          <header className="app-settings-header">
            <DialogTitle>
              <span>Settings</span>
              <span aria-hidden>/</span>
              {page}
            </DialogTitle>
            <Button
              type="button"
              className="sidebar-icon-button"
              aria-label="Close settings"
              title="Close (Esc)"
              render={<DialogClose />}
            >
              <XIcon aria-hidden />
            </Button>
          </header>
          <div className="app-settings-scroll">
            <div className="app-settings-page">
              {page === "Appearance" ? (
                <section aria-label="Appearance">
                  <ThemeSelect />
                </section>
              ) : page === "Chat" ? (
                <ChatSettings beforeClose={beforeClose} />
              ) : page === "Environments" || page === "Sharing & access" ? (
                <EnvironmentSettings
                  page={page}
                  onSharing={() => {
                    void navigateTo("Sharing & access");
                  }}
                />
              ) : page === "Teams" ? (
                <TeamsSettings
                  beforeClose={beforeClose}
                  initialTeamId={initialTeamId}
                />
              ) : (
                <ProviderSettings />
              )}
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
