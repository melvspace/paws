export type EnvironmentAction =
  | "new-agent"
  | "new-team"
  | "agent-settings"
  | "team-settings";

export function environmentDestination(
  environmentId: string | null,
  target: {
    agentId?: string;
    teamId?: string;
    action?: EnvironmentAction;
  } = {},
) {
  const url = new URL(window.location.href);
  url.searchParams.delete("action");
  url.searchParams.delete("team");

  if (environmentId) url.searchParams.set("environment", environmentId);
  else url.searchParams.delete("environment");

  if (target.action) url.searchParams.set("action", target.action);
  if (target.teamId) url.searchParams.set("team", target.teamId);

  url.hash = target.agentId ? `agent-${target.agentId}` : "";

  return url.pathname + url.search + url.hash;
}
