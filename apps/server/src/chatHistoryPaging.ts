import type { Conversation } from "@paws/contracts";
import { ChatError } from "./ChatError.ts";

export const CHAT_HISTORY_POLICY = {
  recentTurns: 10,
  olderTurns: 20,
  maxMessages: 500,
  maxUnanchoredMessages: 75,
  maxBytes: 1_048_576,
};

// Message identity is stable across streaming edits and newly appended replies.
// The cursor is scoped to the agent, and never contains message text.
export function chatHistoryPage(
  conversation: Conversation,
  cursor?: string,
): Conversation {
  let end = conversation.messages.length;

  if (cursor !== undefined) {
    if (!cursor.length || cursor.length > 4096)
      throw new ChatError(
        400,
        "Invalid history cursor. Reload the conversation.",
      );

    try {
      const value: unknown = JSON.parse(
        Buffer.from(cursor, "base64url").toString(),
      );

      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        value[0] !== conversation.agentId ||
        typeof value[1] !== "string"
      )
        throw new Error("Invalid cursor");

      end = conversation.messages.findIndex(
        (message) => message.id === value[1],
      );

      if (end < 0) throw new Error("Missing anchor");
    } catch {
      throw new ChatError(400, "History changed. Reload the conversation.");
    }
  }

  let start = end;
  let bytes = 0;
  let turns = 0;
  const turnLimit =
    cursor === undefined
      ? CHAT_HISTORY_POLICY.recentTurns
      : CHAT_HISTORY_POLICY.olderTurns;

  while (start > 0 && end - start < CHAT_HISTORY_POLICY.maxMessages) {
    const message = conversation.messages[start - 1]!;
    const size = Buffer.byteLength(JSON.stringify(message));

    // Always include one message, even when a single reply exceeds the budget.
    if (start < end && bytes + size > CHAT_HISTORY_POLICY.maxBytes) break;

    bytes += size;
    start -= 1;

    if (message.role === "user" && !message.interaction) turns += 1;

    if (turns >= turnLimit) break;
  }

  if (!turns)
    start = Math.max(start, end - CHAT_HISTORY_POLICY.maxUnanchoredMessages);

  const messages = conversation.messages.slice(start, end);
  const ids = new Set(messages.map((message) => message.id));

  return {
    ...conversation,
    messages,
    handoffs: conversation.handoffs?.filter((handoff) =>
      ids.has(handoff.beforeMessageId),
    ),
    historyCursor:
      start > 0 && messages[0]
        ? Buffer.from(
            JSON.stringify([conversation.agentId, messages[0].id]),
          ).toString("base64url")
        : null,
  };
}
