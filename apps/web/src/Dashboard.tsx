import { useAtomValue } from "@effect/atom-react";
import { appAtomRegistry } from "./lib/atomRegistry.ts";
import { Button } from "./components/ui/button.tsx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Plus, Bot, MenuIcon } from "lucide-react";
import { Dialog, DialogPopup, DialogTrigger } from "./components/ui/dialog.tsx";
import { useMobileLayout } from "./lib/useMobileLayout.ts";
import { connectAgents, agentsAtom } from "@paws/client-runtime";
import { AppSettingsDialog } from "./settings/AppSettingsDialog.tsx";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { AgentDialog } from "./AgentDialog.tsx";
import { AgentWorkspace } from "./workspace/AgentWorkspace.tsx";
import { selectedAgent } from "./workspace/state.ts";
import type { Agent } from "@paws/contracts";

function subscribeToSelection(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);

  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

function selectionSnapshot() {
  return window.location.hash;
}

export function Dashboard() {
  const mobile = useMobileLayout();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { snapshot, connected, error } = useAtomValue(agentsAtom);
  const [dialog, setDialog] = useState<{ agent: Agent | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<
    "Appearance" | "Providers" | null
  >(null);
  const hash = useSyncExternalStore(subscribeToSelection, selectionSnapshot);
  const agent = selectedAgent(snapshot.agents, hash);

  // The WebSocket is an external resource owned by this mounted view.
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";

    return connectAgents(appAtomRegistry, `${protocol}//${location.host}/ws`);
  }, []);

  const sidebar = (
    <AgentSidebar
      agents={snapshot.agents}
      selectedId={agent?.id ?? null}
      connected={connected}
      onCreate={() => {
        setNavigationOpen(false);
        setDialog({ agent: null });
      }}
      onSettings={(target) => {
        setNavigationOpen(false);
        setDialog({ agent: target });
      }}
      onAppSettings={() => {
        setNavigationOpen(false);
        setSettingsOpen("Appearance");
      }}
      onNavigate={() => setNavigationOpen(false)}
      onClose={mobile ? () => setNavigationOpen(false) : undefined}
    />
  );
  const navigation = mobile ? (
    <Button
      className="sidebar-icon-button"
      aria-label="Open navigation"
      render={<DialogTrigger />}
    >
      <MenuIcon aria-hidden />
    </Button>
  ) : null;

  return (
    <Dialog open={mobile && navigationOpen} onOpenChange={setNavigationOpen}>
      <div className="app-shell">
        {mobile ? (
          <DialogPopup className="navigation-drawer" aria-label="Navigation">
            {sidebar}
          </DialogPopup>
        ) : (
          sidebar
        )}
        <main className="workspace-main">
          {error && (
            <p className="workspace-error" role="alert">
              {error}
            </p>
          )}
          {agent ? (
            <AgentWorkspace
              key={agent.id}
              agent={agent}
              navigation={navigation}
              onSettings={() => setDialog({ agent })}
              onProviderSettings={() => setSettingsOpen("Providers")}
            />
          ) : (
            <div className="workspace-welcome">
              {mobile && (
                <header className="workspace-header">
                  {navigation}
                  <span>Paws</span>
                </header>
              )}
              <div className="workspace-welcome-content">
                <Bot size={32} aria-hidden />
                <h1>{connected ? "No agents yet" : "Connecting…"}</h1>
                <Button
                  disabled={!connected}
                  onClick={() => setDialog({ agent: null })}
                >
                  <Plus size={18} aria-hidden /> New agent
                </Button>
              </div>
            </div>
          )}
        </main>
        {settingsOpen && (
          <AppSettingsDialog
            initialPage={settingsOpen}
            onDismiss={() => setSettingsOpen(null)}
          />
        )}
        {dialog && (
          <AgentDialog
            agent={dialog.agent}
            connected={connected}
            onDismiss={() => setDialog(null)}
          />
        )}
      </div>
    </Dialog>
  );
}
