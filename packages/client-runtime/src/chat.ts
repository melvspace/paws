import { environmentFetch } from "./transport.ts";
import { Atom } from "effect/reactivity";
import { Schema } from "effect";
import {
  AgentSkills,
  ChatAttachment,
  Conversation,
  type SendChat,
  type MarkChatRead,
  type ChatQueueAction,
  type ChatMessage,
} from "@paws/contracts";

export const conversationsAtom = Atom.make<readonly Conversation[]>([]).pipe(
  Atom.keepAlive,
);

// Separate local sends from authoritative snapshots so WebSocket updates cannot
// erase an in-flight message. Only ordinary messages belong here, never secrets.
export interface OutgoingMessage {
  agentId: string;
  input: SendChat;
  message: ChatMessage;
  status: "sending" | "failed";
  error: string | null;
}

export const outgoingMessagesAtom = Atom.make<readonly OutgoingMessage[]>(
  [],
).pipe(Atom.keepAlive);

export async function chatRequest(
  agentId: string,
  input?:
    | SendChat
    | ChatQueueAction
    | MarkChatRead
    | "stop"
    | "compact"
    | "continue",
) {
  const response = await environmentFetch(
    `/api/agents/${encodeURIComponent(agentId)}/chat${typeof input === "string" ? `/${input}` : input && "action" in input ? "/queue" : input && "messageId" in input ? "/read" : ""}`,
    {
      method: input ? "POST" : "GET",
      ...(input && typeof input !== "string"
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }
        : {}),
    },
  );
  const body: unknown = await response.json();

  if (!response.ok) {
    const error = Schema.decodeUnknownSync(
      Schema.Struct({ error: Schema.String }),
    )(body);

    throw new Error(error.error);
  }

  return Schema.decodeUnknownSync(Conversation)(body);
}

export async function loadAgentSkills(agentId: string, signal?: AbortSignal) {
  const response = await environmentFetch(
    `/api/agents/${encodeURIComponent(agentId)}/chat/skills`,
    { signal: signal ?? null },
  );

  if (!response.ok) throw new Error("Could not load skills. Try again.");

  return Schema.decodeUnknownSync(AgentSkills)(await response.json());
}

export async function uploadChatAttachment(
  agentId: string,
  file: File,
  signal: AbortSignal,
) {
  const response = await environmentFetch(
    `/api/agents/${encodeURIComponent(agentId)}/chat/uploads`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file,
      signal,
    },
  );

  if (!response.ok)
    throw new Error(`Could not upload ${file.name}. Try again.`);

  return Schema.decodeUnknownSync(ChatAttachment)(await response.json());
}

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

export async function loadChatHistory(agentId: string, cursor: string) {
  const response = await environmentFetch(
    `/api/agents/${encodeURIComponent(agentId)}/chat?before=${encodeURIComponent(cursor)}`,
  );
  const body: unknown = await response.json();

  if (!response.ok) {
    const error = Schema.decodeUnknownSync(
      Schema.Struct({ error: Schema.String }),
    )(body);

    throw new Error(error.error);
  }

  return Schema.decodeUnknownSync(Conversation)(body);
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
