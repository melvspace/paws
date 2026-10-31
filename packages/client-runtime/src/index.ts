import { Schema } from "effect";
import { conversationsAtom } from "./chat.ts";
import { providersAtom } from "./providers.ts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import {
  Agent,
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
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket;

  function connect() {
    socket = new WebSocket(url);
    socket.onmessage = (event) => {
      try {
        const snapshot = Schema.decodeUnknownSync(Snapshot)(
          JSON.parse(event.data),
        );

        if (!disposed) {
          registry.set(agentsAtom, { snapshot, connected: true, error: null });

          if (snapshot.conversations)
            registry.set(conversationsAtom, snapshot.conversations);

          if (snapshot.providers) {
            registry.set(providersAtom, {
              providers: snapshot.providers,
              error: null,
            });
          }
        }
      } catch {
        if (!disposed) {
          registry.update(agentsAtom, (state) => ({
            ...state,
            error: "The server sent an invalid agent list.",
          }));
        }
      }
    };
    socket.onclose = () => {
      if (!disposed) {
        registry.update(agentsAtom, (state) => ({
          ...state,
          connected: false,
        }));
        retry = setTimeout(connect, 2000);
      }
    };
  }

  connect();

  return () => {
    disposed = true;
    clearTimeout(retry);
    socket.close();
    registry.update(agentsAtom, (state) => ({ ...state, connected: false }));
  };
}

export async function createAgent(input: CreateAgent) {
  const response = await fetch("/api/agents", {
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
  const response = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(
      "Could not save agent settings. Check your connection and name.",
    );
  }
}

export async function deleteAgent(id: string) {
  const response = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

  if (!response.ok && response.status !== 404) {
    throw new Error("Could not delete agent. Please try again.");
  }
}

export * from "./providers.ts";

export * from "./chat.ts";
