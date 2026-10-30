import { Schema } from "effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import {
  ProvidersSnapshot,
  ProviderSnapshot,
  type ProviderDriver,
  type UpdateProvider,
  type UpdateProviderEnvironment,
} from "@paws/contracts";

export const providersAtom = Atom.make<{
  providers: readonly ProviderSnapshot[];
  error: string | null;
}>({ providers: [], error: null }).pipe(Atom.keepAlive);

export async function loadProviders(registry: AtomRegistry.AtomRegistry) {
  try {
    const response = await fetch("/api/providers");

    if (!response.ok) throw new Error("Could not load providers.");

    const snapshot = Schema.decodeUnknownSync(ProvidersSnapshot)(
      await response.json(),
    );
    registry.set(providersAtom, { ...snapshot, error: null });
  } catch {
    registry.update(providersAtom, (state) => ({
      ...state,
      error: "Could not load providers. Try again.",
    }));
  }
}

export async function changeProvider(
  registry: AtomRegistry.AtomRegistry,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?:
    | UpdateProvider
    | UpdateProviderEnvironment
    | { driver: ProviderDriver },
) {
  const response = await fetch(`/api/providers${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok)
    throw new Error(
      "Could not update provider. Check your connection and configuration.",
    );

  const result: unknown = await response.json();
  await loadProviders(registry);

  return method === "DELETE"
    ? null
    : Schema.decodeUnknownSync(ProviderSnapshot)(result);
}
