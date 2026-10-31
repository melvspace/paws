import type { ChatHandoff, ChatMessage } from "@paws/contracts";

// Classify legacy events from the preceding session boundary. Source models
// describe transferred history and are preserved independently of event kind.
export function handoffPresentation(
  handoffs: readonly ChatHandoff[],
  messages: readonly ChatMessage[],
): ChatHandoff[] {
  let previousHandoff: ChatHandoff | undefined;
  let previousBoundary = 0;

  return handoffs.map((handoff) => {
    const boundary = messages.findIndex(
      (message) => message.id === handoff.beforeMessageId,
    );
    const preceding =
      boundary >= 0
        ? messages
            .slice(previousBoundary, boundary)
            .findLast(
              (message) => message.role === "assistant" && message.model,
            )?.model
        : undefined;
    const source = preceding ?? previousHandoff?.to;
    const kind =
      handoff.kind ??
      (source
        ? source.providerId === handoff.to.providerId
          ? "session-restoration"
          : "provider-switch"
        : handoff.from.every(
              (model) => model.providerId === handoff.to.providerId,
            )
          ? "session-restoration"
          : "provider-switch");
    previousHandoff = handoff;
    previousBoundary = Math.max(0, boundary);

    return {
      ...handoff,
      kind,
    };
  });
}
