import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { peerRetriesAtom, retryPeerMessage } from "./peerMessages.ts";

it("deduplicates simultaneous retries from different UI controls", async () => {
  const registry = AtomRegistry.make();
  let finish = (_response: Response) => {};
  const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );

  try {
    const first = retryPeerMessage(registry, "sender", "event");
    const second = retryPeerMessage(registry, "recipient", "event");
    expect(second).toBe(first);
    expect(registry.get(peerRetriesAtom).event?.status).toBe("retrying");
    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    finish(
      new Response(JSON.stringify({ requestId: "retry" }), { status: 202 }),
    );
    await first;
    expect(registry.get(peerRetriesAtom).event?.status).toBe("retried");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/agents/sender/peer-messages/event/retry",
    );
  } finally {
    finish(
      new Response(JSON.stringify({ requestId: "retry" }), { status: 202 }),
    );
    fetchMock.mockRestore();
    registry.dispose();
  }
});

it("shows safe errors and releases failed retries so the user can try again", async () => {
  const registry = AtomRegistry.make();
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => {
      throw new Error("PRIVATE_NETWORK_DETAILS");
    })
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "This request was replaced." }), {
        status: 409,
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ requestId: "retry" }), { status: 202 }),
    );

  try {
    await retryPeerMessage(registry, "sender", "event");
    expect(registry.get(peerRetriesAtom).event).toEqual({
      status: "failed",
      error: "Could not retry. Check your connection and try again.",
    });
    expect(JSON.stringify(registry.get(peerRetriesAtom))).not.toContain(
      "PRIVATE_NETWORK_DETAILS",
    );
    await retryPeerMessage(registry, "sender", "event");
    expect(registry.get(peerRetriesAtom).event?.error).toBe(
      "This request was replaced.",
    );
    await retryPeerMessage(registry, "sender", "event");
    expect(registry.get(peerRetriesAtom).event).toEqual({ status: "retried" });
    expect(fetchMock.mock.calls).toHaveLength(3);
  } finally {
    fetchMock.mockRestore();
    registry.dispose();
  }
});
