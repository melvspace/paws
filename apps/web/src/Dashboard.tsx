import { useAtomValue } from "@effect/atom-react";
import { appAtomRegistry } from "./lib/atomRegistry.ts";
import { Button } from "./components/ui/button.tsx";
import { useEffect, useRef, useState } from "react";
import { Plus, Bot, MenuIcon } from "lucide-react";
import { Dialog, DialogPopup, DialogTrigger } from "./components/ui/dialog.tsx";
import { useMobileLayout } from "./lib/useMobileLayout.ts";
import { connectAgents, agentsAtom } from "@paws/client-runtime";
import { AppSettingsDialog } from "./settings/AppSettingsDialog.tsx";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { TeamDialog } from "./TeamDialog.tsx";
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

export function Dashboard() {
  const mobile = useMobileLayout();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { snapshot, connected, error } = useAtomValue(agentsAtom);
  const [dialog, setDialog] = useState<{
    agent: Agent | null;
    teamId: string | null;
  } | null>(null);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [settingsTeamId, setSettingsTeamId] = useState<string | null>(null);
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const beforeLeave = useRef<(() => Promise<void>) | null>(null);
  const navigating = useRef(false);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<
    "Appearance" | "Providers" | "Teams" | null
  >(null);
  const [hash, setHash] = useState(() => window.location.hash);
  const acceptedHash = useRef(hash);
  const agent = selectedAgent(snapshot.agents, hash);

  async function navigate(action: () => void) {
    if (navigating.current) {
      pendingNavigation.current = action;

      return;
    }

    navigating.current = true;

    try {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();

      await beforeLeave.current?.();
      setNavigationOpen(false);
      action();
      acceptedHash.current = window.location.hash;
      setHash(acceptedHash.current);
    } catch {
      // Settings retain failed edits and explain how to recover.
    } finally {
      navigating.current = false;
      const pending = pendingNavigation.current;
      pendingNavigation.current = null;

      if (pending) void navigate(pending);
    }
  }

  useEffect(() =>
    subscribeToSelection(() => {
      const requested = window.location.hash;

      if (requested === acceptedHash.current) return;

      const path = window.location.pathname + window.location.search;
      // Keep the URL on the active editor until its pending work is saved.
      history.replaceState(null, "", path + acceptedHash.current);
      void navigate(() => {
        history.replaceState(null, "", path + requested);
        setSettingsAgentId(null);
      });
    }),
  );

  function closeAgentSettings() {
    setSettingsAgentId(null);
  }

  function openAgentSettings(target: Agent) {
    void navigate(() => {
      history.pushState(null, "", `#agent-${target.id}`);
      setSettingsAgentId(target.id);
    });
  }

  // The WebSocket is an external resource owned by this mounted view.
  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";

    return connectAgents(appAtomRegistry, `${protocol}//${location.host}/ws`);
  }, []);

  const sidebar = (
    <AgentSidebar
      agents={snapshot.agents}
      workingAgentIds={snapshot.teamworkActiveAgentIds ?? []}
      teams={snapshot.teams ?? []}
      selectedId={agent?.id ?? null}
      connected={connected}
      onCreate={(teamId) => {
        void navigate(() => setDialog({ agent: null, teamId: teamId ?? null }));
      }}
      onCreateTeam={() => {
        void navigate(() => setCreatingTeam(true));
      }}
      onTeamSettings={(teamId) => {
        setNavigationOpen(false);
        setSettingsTeamId(teamId);
        setSettingsOpen("Teams");
      }}
      onSettings={openAgentSettings}
      onAppSettings={() => {
        setNavigationOpen(false);
        setSettingsTeamId(null);
        setSettingsOpen("Appearance");
      }}
      onNavigate={(target) => {
        void navigate(() => {
          closeAgentSettings();
          history.pushState(null, "", `#agent-${target.id}`);
        });
      }}
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
              onSettings={() => openAgentSettings(agent)}
              settingsOpen={settingsAgentId === agent.id}
              beforeLeave={beforeLeave}
              onSettingsClosed={closeAgentSettings}
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
                  onClick={() => setDialog({ agent: null, teamId: null })}
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
            initialTeamId={settingsTeamId}
            onDismiss={() => {
              setSettingsOpen(null);
              setSettingsTeamId(null);
            }}
          />
        )}
        {creatingTeam && (
          <TeamDialog
            connected={connected}
            onDismiss={() => setCreatingTeam(false)}
          />
        )}
        {dialog && (
          <AgentDialog
            agent={dialog.agent}
            initialTeamId={dialog.teamId}
            connected={connected}
            onDismiss={() => setDialog(null)}
          />
        )}
      </div>
    </Dialog>
  );
}
