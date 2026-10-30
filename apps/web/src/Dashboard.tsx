import { useAtomValue } from "@effect/atom-react";
import { appAtomRegistry } from "./lib/atomRegistry.ts";
import { Button } from "./components/ui/button.tsx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Plus, Bot } from "lucide-react";
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

  return (
    <div className="app-shell">
      <AgentSidebar
        agents={snapshot.agents}
        selectedId={agent?.id ?? null}
        connected={connected}
        onCreate={() => setDialog({ agent: null })}
        onSettings={(target) => setDialog({ agent: target })}
        onAppSettings={() => setSettingsOpen("Appearance")}
      />
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
            onSettings={() => setDialog({ agent })}
            onProviderSettings={() => setSettingsOpen("Providers")}
          />
        ) : (
          <div className="workspace-welcome">
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
  );
}
