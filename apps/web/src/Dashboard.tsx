import { useAtomValue } from "@effect/atom-react";
import { appAtomRegistry } from "./lib/atomRegistry.ts";
import { Button } from "./components/ui/button.tsx";
import { useEffect, useRef, useState } from "react";
import { Plus, Bot, MenuIcon } from "lucide-react";
import { Dialog, DialogPopup, DialogTrigger } from "./components/ui/dialog.tsx";
import { useMobileLayout } from "./lib/useMobileLayout.ts";
import { connectAgents, agentsAtom } from "@paws/client-runtime";
import { AppSettingsDialog } from "./settings/AppSettingsDialog.tsx";
import {
  environmentDestination,
  type EnvironmentAction,
} from "./environmentNavigation.ts";
import {
  activeEnvironmentId,
  connectEnvironmentRosters,
  environmentRostersAtom,
} from "@paws/client-runtime";
import { environmentSocketUrl } from "@paws/client-runtime";
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
  const environmentId = activeEnvironmentId();
  const { rosters, error: rosterError } = useAtomValue(environmentRostersAtom);
  const initial = new URLSearchParams(window.location.search);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { snapshot, connected, error } = useAtomValue(agentsAtom);
  const [dialog, setDialog] = useState<{
    agent: Agent | null;
    teamId: string | null;
  } | null>(() =>
    initial.get("action") === "new-agent"
      ? { agent: null, teamId: initial.get("team") }
      : null,
  );
  const [creatingTeam, setCreatingTeam] = useState(
    () => initial.get("action") === "new-team",
  );
  const [settingsTeamId, setSettingsTeamId] = useState<string | null>(() =>
    initial.get("action") === "team-settings" ? initial.get("team") : null,
  );
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(() =>
    initial.get("action") === "agent-settings"
      ? window.location.hash.slice(7)
      : null,
  );
  const beforeLeave = useRef<(() => Promise<void>) | null>(null);
  const navigating = useRef(false);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<
    "Appearance" | "Providers" | "Teams" | "Environments" | null
  >(() => (initial.get("action") === "team-settings" ? "Teams" : null));
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

  function onEnvironment(
    targetId: string | null | undefined,
    target: { agentId?: string; teamId?: string; action?: EnvironmentAction },
    action: () => void,
  ) {
    void navigate(() => {
      const destination = targetId === undefined ? environmentId : targetId;

      if (destination !== environmentId) {
        window.location.assign(environmentDestination(destination, target));
      } else action();
    });
  }

  function openAgentSettings(target: Agent, targetEnvironment?: string | null) {
    onEnvironment(
      targetEnvironment,
      { agentId: target.id, action: "agent-settings" },
      () => {
        history.pushState(null, "", `#agent-${target.id}`);
        setSettingsAgentId(target.id);
      },
    );
  }

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("action");
    url.searchParams.delete("team");
    history.replaceState(null, "", url.pathname + url.search + url.hash);

    return connectEnvironmentRosters(appAtomRegistry);
  }, []);

  // The WebSocket is an external resource owned by this mounted view.
  useEffect(() => {
    return connectAgents(appAtomRegistry, environmentSocketUrl("/ws"));
  }, []);

  const sidebar = (
    <AgentSidebar
      environments={rosters.map((source) =>
        source.id === environmentId
          ? { ...source, snapshot, connected, error }
          : source,
      )}
      activeEnvironmentId={environmentId}
      environmentError={rosterError}
      agents={snapshot.agents}
      workingAgentIds={snapshot.teamworkActiveAgentIds ?? []}
      teams={snapshot.teams ?? []}
      selectedId={agent?.id ?? null}
      connected={connected}
      onCreate={(teamId, targetEnvironment) => {
        onEnvironment(
          targetEnvironment,
          { action: "new-agent", ...(teamId ? { teamId } : {}) },
          () => setDialog({ agent: null, teamId: teamId ?? null }),
        );
      }}
      onCreateTeam={(targetEnvironment) => {
        onEnvironment(targetEnvironment, { action: "new-team" }, () =>
          setCreatingTeam(true),
        );
      }}
      onTeamSettings={(teamId, targetEnvironment) => {
        onEnvironment(
          targetEnvironment,
          { action: "team-settings", teamId },
          () => {
            setSettingsTeamId(teamId);
            setSettingsOpen("Teams");
          },
        );
      }}
      onSettings={openAgentSettings}
      onAppSettings={() => {
        setNavigationOpen(false);
        setSettingsTeamId(null);
        setSettingsOpen("Appearance");
      }}
      onNavigate={(target, targetEnvironment) => {
        onEnvironment(targetEnvironment, { agentId: target.id }, () => {
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
        {settingsOpen &&
          (settingsOpen !== "Teams" || !settingsTeamId || snapshot.teams) && (
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
