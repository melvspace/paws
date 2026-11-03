import { useEffect, useSyncExternalStore } from "react";
import type { Conversation } from "@paws/contracts";

const changeEvent = "paws-conversation-read";
const fallback = new Map<string, string>();
const storageKey = (agentId: string) => `paws.conversation-read.${agentId}`;

function read(agentId: string) {
  if (fallback.has(agentId)) return fallback.get(agentId) ?? "";

  try {
    return localStorage.getItem(storageKey(agentId)) ?? "";
  } catch {
    return fallback.get(agentId) ?? "";
  }
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(changeEvent, listener);

  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(changeEvent, listener);
  };
}

export function useUnreadCount(conversation: Conversation | undefined) {
  const agentId = conversation?.agentId ?? "";
  const marker = useSyncExternalStore(subscribe, () => read(agentId));
  const messages = conversation?.messages ?? [];
  const lastRead = messages.findIndex((message) => message.id === marker);

  return messages
    .slice(lastRead + 1)
    .filter(
      (message) =>
        message.role === "assistant" && !message.streaming && !message.card,
    ).length;
}

export function useMarkConversationRead(
  conversation: Conversation | undefined,
) {
  const agentId = conversation?.agentId;
  const lastMessage = conversation?.messages.findLast(
    (message) => !message.streaming,
  );
  const messageId = lastMessage?.id;

  useEffect(() => {
    function markRead() {
      if (
        !agentId ||
        !messageId ||
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        read(agentId) === messageId
      )
        return;

      try {
        localStorage.setItem(storageKey(agentId), messageId);
        fallback.delete(agentId);
      } catch {
        // Keep read state for this session when storage is unavailable.
        fallback.set(agentId, messageId);
      }

      window.dispatchEvent(new Event(changeEvent));
    }

    markRead();
    window.addEventListener("focus", markRead);
    document.addEventListener("visibilitychange", markRead);

    return () => {
      window.removeEventListener("focus", markRead);
      document.removeEventListener("visibilitychange", markRead);
    };
  }, [agentId, messageId]);
}
