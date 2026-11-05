import { environmentFetch } from "./transport.ts";
import { Schema } from "effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { PeerRetryResult } from "@paws/contracts";

type RetryState = { status: "retrying" | "retried" | "failed"; error?: string };

export const peerRetriesAtom = Atom.make<Readonly<Record<string, RetryState>>>(
  {},
).pipe(Atom.keepAlive);
const inFlight = new Map<string, Promise<void>>();
class PeerRetryError extends Error {}

export function retryPeerMessage(
  registry: AtomRegistry.AtomRegistry,
  agentId: string,
  eventId: string,
) {
  const pending = inFlight.get(eventId);

  if (pending) return pending;

  const update = (next: RetryState) =>
    registry.update(peerRetriesAtom, (state) => ({
      ...state,
      [eventId]: next,
    }));
  update({ status: "retrying" });
  const request = Promise.resolve().then(async () => {
    try {
      const response = await environmentFetch(
        `/api/agents/${encodeURIComponent(agentId)}/peer-messages/${encodeURIComponent(eventId)}/retry`,
        { method: "POST" },
      );
      const data: unknown = await response.json();

      if (!response.ok) {
        const error = Schema.decodeUnknownSync(
          Schema.Struct({ error: Schema.String }),
        )(data);

        throw new PeerRetryError(error.error);
      }

      Schema.decodeUnknownSync(PeerRetryResult)(data);
      update({ status: "retried" });
    } catch (cause) {
      update({
        status: "failed",
        error:
          cause instanceof PeerRetryError
            ? cause.message
            : "Could not retry. Check your connection and try again.",
      });
    } finally {
      inFlight.delete(eventId);
    }
  });
  inFlight.set(eventId, request);

  return request;
}
