import { useEffect, useState } from "react";
import { chatRequest, conversationsAtom } from "@paws/client-runtime";
import type { Conversation } from "@paws/contracts";
import { appAtomRegistry } from "../lib/atomRegistry.ts";

export function useMarkConversationRead(
  conversation: Conversation | undefined,
) {
  const agentId = conversation?.agentId;
  const messageId = conversation?.messages.findLast(
    (message) => message.role === "assistant" && !message.streaming,
  )?.id;
  const lastReadMessageId = conversation?.lastReadMessageId;
  const unreadCount = conversation?.unreadCount ?? 0;
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let pending = false;
    let disposed = false;

    async function markRead() {
      if (
        !agentId ||
        !messageId ||
        unreadCount === 0 ||
        lastReadMessageId === messageId ||
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        pending
      )
        return;

      pending = true;

      try {
        const next = await chatRequest(agentId, { messageId });
        appAtomRegistry.update(conversationsAtom, (items) => {
          const current = items.find((item) => item.agentId === agentId);

          if (current && current.revision > next.revision) return items;

          return [...items.filter((item) => item.agentId !== agentId), next];
        });

        if (!disposed) setError(null);
      } catch {
        if (!disposed) setError("Could not mark messages as read.");
      } finally {
        pending = false;
      }
    }

    const update = () => void markRead();
    update();
    window.addEventListener("focus", update);
    window.addEventListener("online", update);
    document.addEventListener("visibilitychange", update);

    return () => {
      disposed = true;
      window.removeEventListener("focus", update);
      window.removeEventListener("online", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [agentId, messageId, lastReadMessageId, unreadCount, attempt]);

  return { error, retry: () => setAttempt((current) => current + 1) };
}
