import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  chatRequest,
  conversationsAtom,
  outgoingMessagesAtom,
  type OutgoingMessage,
} from "@paws/client-runtime";
import type {
  Conversation,
  SendChat,
  ChatQueueAction,
  ChatAttachment,
} from "@paws/contracts";
import { appAtomRegistry } from "../lib/atomRegistry.ts";

function receive(next: Conversation) {
  appAtomRegistry.update(conversationsAtom, (items) => {
    const current = items.find((item) => item.agentId === next.agentId);

    if (current && current.revision > next.revision) return items;

    return [...items.filter((item) => item.agentId !== next.agentId), next];
  });
}

export function useConversation(agentId: string) {
  const conversations = useAtomValue(conversationsAtom);
  const outgoing = useAtomValue(outgoingMessagesAtom);
  const confirmed = conversations.find((item) => item.agentId === agentId);
  const outbox = outgoing.filter(
    (item) =>
      item.agentId === agentId &&
      !confirmed?.messages.some(
        (message) => message.id === item.input.requestId,
      ),
  );
  const conversation: Conversation | undefined = outbox.length
    ? {
        ...(confirmed ?? {
          agentId,
          revision: 0,
          status: "idle",
          error: null,
          selection: null,
        }),
        messages: [
          ...(confirmed?.messages ?? []),
          ...outbox.map((item) => item.message),
        ],
      }
    : confirmed;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const retry = useRef<{ body: string; requestId: string } | null>(null);

  useEffect(() => {
    if (!confirmed) return;

    const ids = new Set(confirmed.messages.map((message) => message.id));
    appAtomRegistry.update(outgoingMessagesAtom, (items) => {
      const remaining = items.filter(
        (item) => item.agentId !== agentId || !ids.has(item.input.requestId),
      );

      return remaining.length === items.length ? items : remaining;
    });
  }, [agentId, confirmed]);

  useEffect(() => {
    let disposed = false;
    void chatRequest(agentId)
      .then(receive)
      .catch(() => {
        if (!disposed)
          setError("Could not load conversation. Check your connection.");
      });

    return () => {
      disposed = true;
    };
  }, [agentId]);

  async function send(
    input: Omit<SendChat, "requestId">,
    attachments: readonly ChatAttachment[] = [],
    retryId?: string,
  ) {
    if (pending.current) return false;

    pending.current = true;
    setBusy(true);
    setError(null);
    // Keep the retry key stable without retaining a second copy of a secret.
    const body = JSON.stringify(
      input.reply?.secret !== undefined
        ? { ...input, reply: { ...input.reply, secret: "[redacted]" } }
        : input,
    );
    const requestId =
      retryId ??
      (retry.current?.body === body
        ? retry.current.requestId
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""));
    retry.current = { body, requestId };

    if (!input.reply) {
      appAtomRegistry.update(outgoingMessagesAtom, (items) => {
        const existing = items.find(
          (item) => item.input.requestId === requestId,
        );

        return [
          ...items.filter((item) => item.input.requestId !== requestId),
          {
            agentId,
            input: { ...input, requestId },
            message: {
              id: requestId,
              role: "user",
              text: input.text,
              createdAt:
                existing?.message.createdAt ?? new Date().toISOString(),
              ...(attachments.length ? { attachments } : {}),
            },
            status: "sending",
            error: null,
          } satisfies OutgoingMessage,
        ];
      });
    }

    const removeOutgoing = () =>
      appAtomRegistry.update(outgoingMessagesAtom, (items) =>
        items.filter((item) => item.input.requestId !== requestId),
      );

    try {
      receive(await chatRequest(agentId, { ...input, requestId }));
      removeOutgoing();
      retry.current = null;

      return true;
    } catch (cause) {
      const acknowledged = appAtomRegistry
        .get(conversationsAtom)
        .find((item) => item.agentId === agentId)
        ?.messages.some((message) => message.id === requestId);

      if (acknowledged) {
        removeOutgoing();
        retry.current = null;

        return true;
      }

      const message =
        cause instanceof Error ? cause.message : "Could not send message.";

      if (input.reply) setError(message);
      else
        appAtomRegistry.update(outgoingMessagesAtom, (items) =>
          items.map((item) =>
            item.input.requestId === requestId
              ? {
                  ...item,
                  status: "failed",
                  error: message,
                  message: { ...item.message, delivery: "failed" },
                }
              : item,
          ),
        );

      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function retryMessage(requestId: string) {
    const item = appAtomRegistry
      .get(outgoingMessagesAtom)
      .find(
        (entry) =>
          entry.agentId === agentId && entry.input.requestId === requestId,
      );

    if (!item || item.status !== "failed") return Promise.resolve(false);

    const { requestId: id, ...input } = item.input;

    return send(input, item.message.attachments ?? [], id);
  }

  async function control(
    action: "stop" | "compact" | "continue" | ChatQueueAction,
  ) {
    if (pending.current) return false;

    pending.current = true;
    setBusy(true);
    setError(null);

    try {
      receive(await chatRequest(agentId, action));

      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update conversation. Check your connection.",
      );

      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return {
    conversation,
    error: error ?? outbox.findLast((item) => item.error)?.error ?? null,
    busy: busy || outbox.some((item) => item.status === "sending"),
    outgoing: Object.fromEntries(
      outbox.map((item) => [item.input.requestId, item.status]),
    ),
    retryMessage,
    send,
    stop: () => control("stop"),
    compact: () => control("compact"),
    continueInterrupted: () => control("continue"),
    updateQueue: (action: ChatQueueAction) => control(action),
  };
}
