import type { Conversation } from "@paws/contracts";

// Live snapshots replace their window authoritatively, while retaining an
// overlapping prefix explicitly fetched by the reader. Reset on a history gap.
export function mergeConversation(
  current: Conversation | undefined,
  next: Conversation,
): Conversation {
  if (!current || next.revision < current.revision) return current ?? next;

  if (next.historyCursor === undefined) return next;

  const first = next.messages[0]?.id;
  const overlap = current.messages.findIndex((message) => message.id === first);

  if (overlap < 0) return next;

  const messages = [...current.messages.slice(0, overlap), ...next.messages];
  const ids = new Set(messages.map((message) => message.id));
  const handoffs = new Map(
    [...(current.handoffs ?? []), ...(next.handoffs ?? [])]
      .filter((handoff) => ids.has(handoff.beforeMessageId))
      .map((handoff) => [handoff.id, handoff]),
  );

  return {
    ...next,
    messages,
    handoffs: [...handoffs.values()],
    historyCursor: current.historyCursor ?? null,
  };
}

export function prependChatHistory(
  current: Conversation,
  page: Conversation,
  cursor: string,
): Conversation {
  if (current.agentId !== page.agentId || current.historyCursor !== cursor)
    return current;

  const ids = new Set(current.messages.map((message) => message.id));
  const handoffs = new Map(
    [...(page.handoffs ?? []), ...(current.handoffs ?? [])].map((handoff) => [
      handoff.id,
      handoff,
    ]),
  );

  return {
    ...current,
    messages: [
      ...page.messages.filter((message) => !ids.has(message.id)),
      ...current.messages,
    ],
    handoffs: [...handoffs.values()],
    historyCursor: page.historyCursor ?? null,
  };
}
