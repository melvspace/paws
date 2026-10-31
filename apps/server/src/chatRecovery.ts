import type {
  ChatInterruptedTurn,
  ChatQueuedInput,
  Conversation,
} from "@paws/contracts";

export function recoverInterruptedConversation(
  conversation: Conversation,
  activeTurn?: ChatInterruptedTurn,
): Conversation {
  const uncertain = new Set(
    conversation.queue
      ?.filter((entry) => entry.steering)
      .map((entry) => entry.requestId),
  );
  const queue: ChatQueuedInput[] = (conversation.queue ?? [])
    .filter((entry) => !entry.steering)
    .map((entry) => ({
      ...entry,
      held: true,
    }));
  // Older conversations stored queued text but not the complete input.
  for (const message of conversation.messages) {
    if (
      message.role === "user" &&
      message.delivery === "queued" &&
      conversation.selection &&
      !uncertain.has(message.id) &&
      !queue.some((entry) => entry.requestId === message.id)
    ) {
      queue.push({
        requestId: message.id,
        text: message.text,
        selection: conversation.selection,
        held: true,
      });
    }
  }

  const interrupted =
    (activeTurn &&
    !queue.some((entry) => entry.requestId === activeTurn.requestId)
      ? activeTurn
      : undefined) ??
    conversation.interrupted ??
    (conversation.queue === undefined &&
    conversation.status === "running" &&
    conversation.selection
      ? {
          requestId:
            conversation.messages.findLast(
              (message) =>
                message.role === "user" && message.delivery !== "queued",
            )?.id ?? "legacy-interrupted",
          selection: conversation.selection,
          activity: conversation.activity ?? "reply",
        }
      : undefined);

  return {
    ...conversation,
    status: "idle",
    error: null,
    queue,
    ...(interrupted ? { interrupted } : {}),
    handoffs: conversation.handoffs?.map((handoff) =>
      handoff.status === "pending" ? { ...handoff, status: "failed" } : handoff,
    ),
    messages: conversation.messages.map((message) => ({
      ...message,
      streaming: false,
      ...(uncertain.has(message.id) ? { delivery: "failed" as const } : {}),
      ...(message.interaction?.delivery === "queued" &&
      !queue.some((entry) => entry.requestId === message.interaction?.eventId)
        ? {
            interaction: {
              ...message.interaction,
              delivery: uncertain.has(message.interaction.eventId)
                ? ("failed" as const)
                : ("cancelled" as const),
            },
          }
        : {}),
    })),
  };
}
