import { Input } from "./components/ui/input.tsx";
import { Button } from "./components/ui/button.tsx";
import { Collapsible } from "@base-ui/react/collapsible";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { conversationsAtom } from "@paws/client-runtime";
import {
  PanelLeft,
  PanelLeftClose,
  SearchIcon,
  SettingsIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { defaultAgentAvatar, type Agent } from "@paws/contracts";
import { AgentAvatar } from "./AgentAvatar.tsx";

interface AgentSidebarProps {
  agents: readonly Agent[];
  selectedId: string | null;
  connected: boolean;
  onCreate: () => void;
  onSettings: (agent: Agent) => void;
  onAppSettings: () => void;
  onNavigate?: () => void;
  onClose?: (() => void) | undefined;
}

export function AgentSidebar({
  agents,
  selectedId,
  connected,
  onCreate,
  onSettings,
  onAppSettings,
  onNavigate,
  onClose,
}: AgentSidebarProps) {
  const conversations = useAtomValue(conversationsAtom);
  const activities = new Map(
    conversations.map(
      ({ agentId, status }) =>
        [agentId, status === "running" ? "working" : status] as const,
    ),
  );
  const [desktopCollapsed, setCollapsed] = useState(false);
  const collapsed = !onClose && desktopCollapsed;
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const visibleAgents = agents.filter((agent) =>
    agent.name.toLocaleLowerCase().includes(search),
  );
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <Collapsible.Root
      open={!collapsed}
      onOpenChange={(open) => setCollapsed(!open)}
      render={<aside />}
      className={collapsed ? "agent-sidebar collapsed" : "agent-sidebar"}
    >
      <div className="sidebar-heading">
        {onClose ? (
          <Button
            className="sidebar-icon-button"
            aria-label="Close navigation"
            onClick={onClose}
          >
            <XIcon aria-hidden />
          </Button>
        ) : (
          <Button
            type="button"
            className="sidebar-icon-button"
            aria-label={toggleLabel}
            title={toggleLabel}
            aria-expanded={!collapsed}
            aria-controls="sidebar-content"
            render={<Collapsible.Trigger />}
          >
            {collapsed ? (
              <PanelLeft aria-hidden />
            ) : (
              <PanelLeftClose aria-hidden />
            )}
          </Button>
        )}
        {!collapsed && (
          <a className="brand" href="/">
            Paws
          </a>
        )}
      </div>
      <Collapsible.Panel
        id="sidebar-content"
        className="sidebar-content"
        keepMounted
        hidden={collapsed}
      >
        <div className="sidebar-toolbar">
          <label className="sidebar-search">
            <SearchIcon size={18} aria-hidden />
            <Input
              type="search"
              aria-label="Search agents"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <Button
            type="button"
            className="sidebar-icon-button"
            aria-label="New agent"
            title="New agent"
            disabled={!connected}
            onClick={onCreate}
          >
            <PlusIcon aria-hidden />
          </Button>
        </div>
        <nav className="sidebar-agents" aria-label="Agents">
          <ul>
            {visibleAgents.map((agent) => (
              <li
                key={agent.id}
                className="sidebar-agent-row"
                data-selected={agent.id === selectedId}
              >
                <a
                  href={`#agent-${agent.id}`}
                  onClick={onNavigate}
                  title={agent.name}
                  aria-current={agent.id === selectedId ? "page" : undefined}
                >
                  <AgentAvatar
                    avatar={agent.avatar ?? defaultAgentAvatar(agent.id)}
                    animated={connected && !collapsed}
                    activity={activities.get(agent.id) ?? "idle"}
                  />
                  <span>{agent.name}</span>
                </a>
                <Button
                  type="button"
                  className="sidebar-icon-button agent-settings-button"
                  aria-label={`Settings for ${agent.name}`}
                  title={`Settings for ${agent.name}`}
                  onClick={() => onSettings(agent)}
                >
                  <SettingsIcon aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          {visibleAgents.length === 0 && (
            <p className="sidebar-empty">
              {search
                ? "No matching agents"
                : connected
                  ? "No agents yet"
                  : "Connecting…"}
            </p>
          )}
        </nav>
      </Collapsible.Panel>
      <div className="sidebar-footer">
        <Button
          type="button"
          className="sidebar-icon-button"
          aria-label="Settings"
          title="Settings"
          onClick={onAppSettings}
        >
          <SettingsIcon aria-hidden />
        </Button>
      </div>
    </Collapsible.Root>
  );
}
