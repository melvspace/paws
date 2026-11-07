import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import { Schema } from "effect";
import {
  EnvironmentIdentity,
  type Conversation,
  type Snapshot,
} from "@paws/contracts";
import {
  createRemoteClient,
  RemoteAuthenticationError,
  subscribeRemote,
  type RemoteConnection,
  type RemoteSocketFactory,
} from "@paws/client-runtime/remote";
import {
  mergeConversation,
  prependChatHistory,
} from "@paws/client-runtime/conversations";

const storageKey = "paws.connection";
const storedConnection = Schema.Struct({
  origin: Schema.String,
  session: Schema.String,
  kind: Schema.optional(Schema.Literal("environment")),
  identity: Schema.optional(EnvironmentIdentity),
});
const empty: Snapshot = { agents: [] };
const openSocket: RemoteSocketFactory = (
  url,
  headers,
  receive,
  disconnected,
) => {
  const socket = new WebSocket(url, undefined, { headers });
  socket.onmessage = (event) => receive(event.data);
  socket.onclose = disconnected;
  socket.onerror = () => {
    disconnected();
    socket.close();
  };

  return { close: () => socket.close() };
};

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Try again.";

export function useWorkspace() {
  const [connection, setConnection] = useState<RemoteConnection | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [snapshot, setSnapshot] = useState(empty);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const client = useMemo(
    () => (connection ? createRemoteClient(connection) : null),
    [connection],
  );
  const activeClient = useRef(client);
  activeClient.current = client;

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(storageKey)
      .then((value) => {
        if (!active || !value) return;

        const saved = Schema.decodeUnknownSync(storedConnection)(
          JSON.parse(value),
        );
        createRemoteClient(saved);
        setConnection(saved);
      })
      .catch(() => {
        if (active)
          setError("Could not restore your connection. Connect again.");
      })
      .finally(() => {
        if (active) setRestoring(false);
      });

    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const merge = useCallback(
    (conversation: Conversation) => {
      if (activeClient.current !== client) return;

      setSnapshot((current) => ({
        ...current,
        conversations: [
          ...(current.conversations ?? []).filter(
            (item) => item.agentId !== conversation.agentId,
          ),
          mergeConversation(
            current.conversations?.find(
              (item) => item.agentId === conversation.agentId,
            ),
            conversation,
          ),
        ],
      }));
    },
    [client],
  );

  useEffect(() => {
    if (!client || !foreground) return;

    let active = true;
    let close: (() => void) | undefined;
    const controller = new AbortController();
    setConnected(false);
    setError(null);

    function receive(next: Snapshot | null, failure: string | null) {
      if (!active || activeClient.current !== client) return;

      setConnected(!!next);
      setError(failure);

      if (next) {
        setSnapshot((current) => ({
          ...next,
          conversations:
            next.conversations?.map((conversation) =>
              mergeConversation(
                current.conversations?.find(
                  (item) => item.agentId === conversation.agentId,
                ),
                conversation,
              ),
            ) ?? [],
        }));
      }
    }

    void client
      .snapshot(controller.signal)
      .then((next) => {
        if (!active || activeClient.current !== client) return;

        receive(next, null);
        close = subscribeRemote(client, openSocket, receive);
      })
      .catch((failure: unknown) => {
        if (!active) return;

        setError(errorText(failure));

        if (failure instanceof RemoteAuthenticationError) {
          setConnection(null);
          setSnapshot(empty);
        }
      });

    return () => {
      active = false;
      controller.abort();
      close?.();
    };
  }, [client, foreground, attempt]);

  async function connect(next: RemoteConnection, signal?: AbortSignal) {
    // Verify before persisting so a bad gateway cannot replace a working session.
    await createRemoteClient(next).snapshot(signal);
    signal?.throwIfAborted();
    await SecureStore.setItemAsync(storageKey, JSON.stringify(next));
    if (signal?.aborted) {
      await SecureStore.deleteItemAsync(storageKey);
      signal.throwIfAborted();
    }

    activeClient.current = null;
    setSnapshot(empty);
    setConnection(next);
  }

  async function disconnect() {
    await SecureStore.deleteItemAsync(storageKey);
    activeClient.current = null;
    setConnection(null);
    setSnapshot(empty);
    setError(null);
  }

  return {
    client,
    connection,
    restoring,
    snapshot,
    connected: connected && foreground,
    error,
    connect,
    disconnect,
    retry: () => setAttempt((value) => value + 1),
    merge,
    prepend: (agentId: string, page: Conversation, cursor: string) => {
      if (activeClient.current !== client) return;

      setSnapshot((current) => ({
        ...current,
        conversations:
          current.conversations?.map((conversation) =>
            conversation.agentId === agentId
              ? prependChatHistory(conversation, page, cursor)
              : conversation,
          ) ?? [],
      }));
    },
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
