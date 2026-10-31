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
}: {
  onDismiss: () => void;
  initialPage?: "Appearance" | "Chat" | "Providers";
}) {
  const [page, setPage] = useState(initialPage);
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
        "chat follow-ups queue steer running turn send default behavior composer",
      Icon: MessageSquareIcon,
    },
    {
      name: "Providers" as const,
      keywords:
        "providers models codex claude cursor grok fx opencode antigravity muse pi acp authentication",
      Icon: PlugIcon,
    },
  ].filter((item) => item.keywords.includes(query.trim().toLowerCase()));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
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
              <Button
                className="settings-nav-item"
                aria-current={page === name ? "page" : undefined}
                onClick={() => setPage(name)}
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
                <ChatSettings />
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
