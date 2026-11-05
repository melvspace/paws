import { Atom, type AtomRegistry } from "effect/reactivity";
import { loadEnvironments } from "./environments.ts";
import { activeEnvironmentId, environmentSocketUrl } from "./transport.ts";
import { subscribeSnapshot, type SnapshotConnection } from "./snapshots.ts";

export interface EnvironmentRoster extends SnapshotConnection {
  id: string | null;
  name: string;
}

export const environmentRostersAtom = Atom.make<{
  rosters: readonly EnvironmentRoster[];
  error: string | null;
}>({ rosters: [], error: null }).pipe(Atom.keepAlive);

// The active workspace owns its snapshot subscription. Other machines have
// independent subscriptions so an offline peer cannot hide another roster.
export function connectEnvironmentRosters(registry: AtomRegistry.AtomRegistry) {
  let disposed = false;
  let revision = 0;
  const active = activeEnvironmentId();
  const connections = new Map<string | null, () => void>();

  async function refresh() {
    const requestRevision = ++revision;

    try {
      const state = await loadEnvironments();

      if (disposed || requestRevision !== revision) return;

      const machines = [
        { id: null, name: state.local.name },
        ...state.linked
          .filter((link) => link.enabled !== false)
          .map(({ id, name }) => ({ id, name })),
      ];
      const previous = registry.get(environmentRostersAtom).rosters;
      registry.set(environmentRostersAtom, {
        rosters: machines.map((machine) => ({
          snapshot: { agents: [] },
          connected: false,
          error: null,
          ...previous.find((item) => item.id === machine.id),
          ...machine,
        })),
        error: null,
      });

      for (const [id, close] of connections) {
        if (machines.some((machine) => machine.id === id)) continue;

        close();
        connections.delete(id);
      }

      for (const machine of machines) {
        if (machine.id === active || connections.has(machine.id)) continue;

        const close = subscribeSnapshot(
          environmentSocketUrl("/ws", machine.id),
          (connection) => {
            if (disposed) return;

            registry.update(environmentRostersAtom, (current) => ({
              ...current,
              rosters: current.rosters.map((item) =>
                item.id === machine.id ? { ...item, ...connection } : item,
              ),
            }));
          },
        );
        connections.set(machine.id, close);
      }
    } catch {
      if (disposed || requestRevision !== revision) return;

      registry.update(environmentRostersAtom, (current) => ({
        ...current,
        error:
          "Could not load connected computers. Retry in Settings → Environments.",
      }));
    }
  }

  const update = () => {
    void refresh();
  };
  update();
  window.addEventListener("paws-environments-changed", update);
  window.addEventListener("focus", update);

  return () => {
    disposed = true;
    window.removeEventListener("paws-environments-changed", update);
    window.removeEventListener("focus", update);

    for (const close of connections.values()) close();

    connections.clear();
    registry.set(environmentRostersAtom, { rosters: [], error: null });
  };
}
