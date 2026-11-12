import { subscribeSnapshot } from "./snapshots.ts";
import { environmentFetch } from "./transport.ts";
import { Schema } from "effect";
import { conversationsAtom, mergeConversation } from "./chat.ts";
import { providersAtom } from "./providers.ts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import {
  Agent,
  Team,
  Snapshot,
  type CreateAgent,
  type UpdateAgent,
} from "@paws/contracts";

export const agentsAtom = Atom.make<{
  snapshot: Snapshot;
  connected: boolean;
  error: string | null;
}>({ snapshot: { agents: [] }, connected: false, error: null }).pipe(
  Atom.keepAlive,
);

export function connectAgents(
  registry: AtomRegistry.AtomRegistry,
  url: string,
) {
  let previousSnapshot: Snapshot | undefined;
  const disconnect = subscribeSnapshot(url, (state) => {
    registry.set(agentsAtom, state);
    const { snapshot } = state;

    if (snapshot === previousSnapshot) return;

    previousSnapshot = snapshot;

    if (snapshot.conversations) {
      registry.update(conversationsAtom, (current) =>
        snapshot.conversations!.map((next) =>
          mergeConversation(
            current.find((item) => item.agentId === next.agentId),
            next,
          ),
        ),
      );
    }

    if (snapshot.providers) {
      registry.set(providersAtom, {
        providers: snapshot.providers,
        error: null,
      });
    }
  });

  return () => {
    disconnect();
    registry.update(agentsAtom, (state) => ({ ...state, connected: false }));
  };
}

export async function createAgent(input: CreateAgent) {
  const response = await environmentFetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(
      "Could not create agent. Check your connection and fields.",
    );
  }

  return Schema.decodeUnknownSync(Agent)(await response.json());
}

export async function updateAgent(id: string, input: UpdateAgent) {
  const response = await environmentFetch(
    `/api/agents/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok) {
    throw new Error(
      response.status === 409
        ? "Only idle agents can change environments."
        : "Could not save agent settings. Check your connection and fields.",
    );
  }
}

export async function deleteAgent(id: string) {
  const response = await environmentFetch(
    `/api/agents/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );

  if (!response.ok && response.status !== 404) {
    throw new Error("Could not delete agent. Please try again.");
  }
}

export * from "./providers.ts";

export * from "./chat.ts";

export async function saveTeam(
  input:
    | import("@paws/contracts").SaveTeam
    | import("@paws/contracts").UpdateTeam,
  id?: string,
) {
  const response = await environmentFetch(
    id ? `/api/teams/${encodeURIComponent(id)}` : "/api/teams",
    {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok)
    throw new Error(
      "Could not save team. Retry, or discard team edits to reload the latest values.",
    );

  return Schema.decodeUnknownSync(Team)(await response.json());
}

export async function deleteTeam(id: string) {
  const response = await environmentFetch(
    `/api/teams/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );

  if (!response.ok && response.status !== 404)
    throw new Error(
      response.status === 409
        ? "Move the team's agents before deleting it."
        : "Could not delete team.",
    );
}

export async function moveAgentTeam(
  id: string,
  fromTeamId: string | null,
  toTeamId: string | null,
  environmentId?: string | null,
) {
  const response = await environmentFetch(
    `/api/agents/${encodeURIComponent(id)}/move`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromTeamId, toTeamId }),
    },
    environmentId,
  );

  if (!response.ok)
    throw new Error(
      response.status === 409
        ? "Only idle agents can move between teams."
        : "Could not move agent. Check your connection and team membership.",
    );
}

export async function getTeam(id: string) {
  const response = await environmentFetch("/api/agents");

  if (!response.ok) throw new Error("Could not reload team. Try again.");

  const snapshot = Schema.decodeUnknownSync(Snapshot)(await response.json());
  const team = snapshot.teams?.find((item) => item.id === id);

  return team ?? null;
}

export * from "./routines.ts";

export * from "./memories.ts";

export * from "./peerMessages.ts";

export * from "./browser.ts";

export * from "./environments.ts";

export * from "./environmentRosters.ts";

export * from "./textGeneration.ts";
