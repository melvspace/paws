import { Input } from "./components/ui/input.tsx";
import { Button } from "./components/ui/button.tsx";
import { Collapsible } from "@base-ui/react/collapsible";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { conversationsAtom, moveAgentTeam } from "@paws/client-runtime";
import {
  PanelLeft,
  PanelLeftClose,
  SearchIcon,
  SettingsIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { defaultAgentAvatar, type Agent, type Team } from "@paws/contracts";
import { AgentAvatar } from "./AgentAvatar.tsx";

interface AgentSidebarProps {
  agents: readonly Agent[];
  teams?: readonly Team[];
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
  teams = [],
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
  const [dragged, setDragged] = useState<{
    agentId: string;
    fromTeamId: string | null;
  } | null>(null);
  const [closedTeams, setClosedTeams] = useState<readonly string[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const isIdle = (id: string) => (activities.get(id) ?? "idle") === "idle";

  async function drop(toTeamId: string | null) {
    const source = dragged;
    setDragged(null);
    setDropTarget(null);

    if (
      !source ||
      source.fromTeamId === toTeamId ||
      !connected ||
      moving ||
      !isIdle(source.agentId)
    )
      return;

    setMoving(source.agentId);
    setMoveError(null);

    try {
      await moveAgentTeam(source.agentId, source.fromTeamId, toTeamId);
      setClosedTeams((ids) =>
        ids.filter((id) => id !== (toTeamId ?? "unassigned")),
      );
    } catch (cause) {
      setMoveError(
        cause instanceof Error ? cause.message : "Could not move agent.",
      );
    } finally {
      setMoving(null);
    }
  }

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
        {moveError && (
          <p className="sidebar-empty" role="alert">
            {moveError}
          </p>
        )}
        {moving && (
          <p className="sidebar-empty" role="status">
            Moving agent…
          </p>
        )}
        <nav className="sidebar-agents" aria-label="Agents">
          {[
            ...teams.map((team) => ({
              id: team.id,
              name: team.name,
              agents: visibleAgents.filter((agent) =>
                agent.teamIds?.includes(team.id),
              ),
            })),
            {
              id: "unassigned",
              name: "Unassigned",
              agents: visibleAgents.filter((agent) => !agent.teamIds?.length),
            },
          ]
            .filter(
              (group) =>
                group.id !== "unassigned" ||
                group.agents.length > 0 ||
                dragged !== null,
            )
            .map((group) => (
              <Collapsible.Root
                key={group.id}
                open={!closedTeams.includes(group.id)}
                onOpenChange={(open) =>
                  setClosedTeams((ids) =>
                    open
                      ? ids.filter((id) => id !== group.id)
                      : [...ids, group.id],
                  )
                }
                className="sidebar-team"
                data-drop-target={dropTarget === group.id}
                onDragOver={(event) => {
                  if (
                    !dragged ||
                    !connected ||
                    moving ||
                    !isIdle(dragged.agentId)
                  )
                    return;

                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTarget(group.id);
                }}
                onDragLeave={(event) => {
                  if (
                    !(event.relatedTarget instanceof Node) ||
                    !event.currentTarget.contains(event.relatedTarget)
                  )
                    setDropTarget(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  void drop(group.id === "unassigned" ? null : group.id);
                }}
              >
                <Collapsible.Trigger className="sidebar-team-heading">
                  {group.name}{" "}
                  {group.agents.length > 0 && (
                    <span>{group.agents.length}</span>
                  )}
                </Collapsible.Trigger>
                <Collapsible.Panel>
                  <ul>
                    {group.agents.map((agent) => (
                      <li
                        key={agent.id}
                        className="sidebar-agent-row"
                        data-selected={agent.id === selectedId}
                        draggable={connected && !moving && isIdle(agent.id)}
                        data-dragging={dragged?.agentId === agent.id}
                        onDragStart={(event) => {
                          if (!connected || moving || !isIdle(agent.id)) {
                            event.preventDefault();

                            return;
                          }

                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData(
                            "application/x-paws-agent",
                            agent.id,
                          );
                          setDragged({
                            agentId: agent.id,
                            fromTeamId:
                              group.id === "unassigned" ? null : group.id,
                          });
                        }}
                        onDragEnd={() => {
                          setDragged(null);
                          setDropTarget(null);
                        }}
                      >
                        <a
                          draggable={false}
                          href={`#agent-${agent.id}`}
                          onClick={onNavigate}
                          title={agent.name}
                          aria-current={
                            agent.id === selectedId ? "page" : undefined
                          }
                        >
                          <AgentAvatar
                            avatar={
                              agent.avatar ?? defaultAgentAvatar(agent.id)
                            }
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
                </Collapsible.Panel>
              </Collapsible.Root>
            ))}
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
