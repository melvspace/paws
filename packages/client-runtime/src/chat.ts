import { Atom } from "effect/reactivity";
import { Schema } from "effect";
import {
  AgentSkills,
  ChatAttachment,
  Conversation,
  type SendChat,
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
  input?: SendChat | ChatQueueAction | "stop" | "compact" | "continue",
) {
  const response = await fetch(
    `/api/agents/${encodeURIComponent(agentId)}/chat${typeof input === "string" ? `/${input}` : input && "action" in input ? "/queue" : ""}`,
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
  const response = await fetch(
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
  const response = await fetch(
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
