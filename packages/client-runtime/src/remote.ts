import { environmentOrigin } from "./pairing.ts";
import { Schema } from "effect";
import {
  Agent,
  ChatAttachment,
  Conversation,
  Snapshot,
  type EnvironmentIdentity,
  type CreateAgent,
  type SendChat,
  type UpdateAgent,
} from "@paws/contracts";

export interface RemoteRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Blob;
  credentials?: "omit";
  signal?: AbortSignal;
}

export type RemoteRequest = (
  url: string,
  options: RemoteRequestOptions,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RemoteConnection {
  origin: string;
  session: string;
  kind?: "environment" | undefined;
  identity?: EnvironmentIdentity | undefined;
}

export class RemoteAuthenticationError extends Error {}

export function remoteOrigin(input: string) {
  const url = new URL(input.trim());

  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("Enter an HTTPS computer address without a path or token.");
  }

  return url.origin;
}

export async function pairRemote(
  address: string,
  token: string,
  request: RemoteRequest = fetch,
): Promise<RemoteConnection> {
  const origin = remoteOrigin(address);
  const response = await request(`${origin}/_companion/session`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `token=${encodeURIComponent(token.trim())}`,
    credentials: "omit",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "Incorrect connection token. Check the token on your computer."
        : "Could not connect. Check the address and HTTPS gateway.",
    );
  }

  const body = Schema.decodeUnknownSync(
    Schema.Struct({
      session: Schema.String.check(
        Schema.isPattern(/^[0-9]{13}\.[A-Za-z0-9_-]{43}$/),
      ),
    }),
  )(await response.json());

  return { origin, session: body.session };
}

export function createRemoteClient(
  connection: RemoteConnection,
  request: RemoteRequest = fetch,
) {
  const origin =
    connection.kind === "environment"
      ? environmentOrigin(connection.origin)
      : remoteOrigin(connection.origin);
  const headers: Record<string, string> = {
    ...(connection.kind === "environment"
      ? { "X-Paws-Client": "native" }
      : { Origin: origin }),
    Authorization: `Bearer ${connection.session}`,
  };

  async function json<T>(
    path: string,
    schema: Schema.Codec<T>,
    options: RemoteRequestOptions = {},
  ) {
    const response = await request(`${origin}${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
      credentials: "omit",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });

    if (response.status === 401) {
      throw new RemoteAuthenticationError("Session expired. Connect again.");
    }

    if (!response.ok) {
      let message = `Request failed (${response.status}). Try again.`;

      try {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({ error: Schema.String }),
        )(await response.json());
        message = body.error;
      } catch {
        // A proxy can return plain text or HTML. Keep the safe fallback.
      }

      throw new Error(message);
    }

    return Schema.decodeUnknownSync(schema)(await response.json());
  }

  const post = (body: unknown): RemoteRequestOptions => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const agentPath = (id: string) => `/api/agents/${encodeURIComponent(id)}`;

  return {
    headers,
    socketUrl: origin.replace(/^http/, "ws") + "/ws",
    snapshot: (signal?: AbortSignal) =>
      json("/api/agents", Snapshot, signal ? { signal } : {}),
    createAgent: (input: CreateAgent) =>
      json("/api/agents", Agent, post(input)),
    updateAgent: (id: string, input: UpdateAgent) =>
      json(agentPath(id), Agent, { ...post(input), method: "PATCH" }),
    chat: (id: string, input?: SendChat | "stop" | "compact" | "continue") =>
      json(
        `${agentPath(id)}/chat${typeof input === "string" ? `/${input}` : ""}`,
        Conversation,
        input ? post(typeof input === "string" ? {} : input) : {},
      ),
    history: (id: string, cursor: string) =>
      json(
        `${agentPath(id)}/chat?before=${encodeURIComponent(cursor)}`,
        Conversation,
      ),
    markRead: (id: string, messageId: string) =>
      json(`${agentPath(id)}/chat/read`, Conversation, post({ messageId })),
    queue: (id: string, requestId: string, action: "resume" | "remove") =>
      json(
        `${agentPath(id)}/chat/queue`,
        Conversation,
        post({ requestId, action }),
      ),
    upload: (id: string, name: string, body: Blob) =>
      json(`${agentPath(id)}/chat/uploads`, ChatAttachment, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(name),
        },
        body,
      }),
    attachmentUrl: (id: string, attachmentId: string) =>
      `${origin}${agentPath(id)}/chat/attachments/${encodeURIComponent(attachmentId)}`,
  };
}

export type RemoteClient = ReturnType<typeof createRemoteClient>;

export interface RemoteSocketFactory {
  (
    url: string,
    headers: Record<string, string>,
    receive: (data: unknown) => void,
    disconnected: () => void,
  ): { close(): void };
}

// The caller owns foreground/background lifecycle. Closing cancels retries and
// ignores late events from an old computer, including during Fast Refresh.
export function subscribeRemote(
  client: RemoteClient,
  open: RemoteSocketFactory,
  receive: (snapshot: Snapshot | null, error: string | null) => void,
) {
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let socket: { close(): void } | undefined;
  let generation = 0;

  function connect() {
    const current = ++generation;
    let ended = false;

    const disconnected = () => {
      if (disposed || current !== generation || ended) return;

      ended = true;
      receive(null, "Disconnected. Reconnecting…");
      retry = setTimeout(connect, 2000);
    };

    try {
      socket = open(
        client.socketUrl,
        client.headers,
        (data) => {
          if (disposed || current !== generation || ended) return;

          try {
            const snapshot = Schema.decodeUnknownSync(Snapshot)(
              JSON.parse(String(data)),
            );
            receive(snapshot, null);
          } catch {
            receive(
              null,
              "The server sent invalid data. Update Paws and retry.",
            );
          }
        },
        disconnected,
      );
    } catch {
      disconnected();
    }
  }

  connect();

  return () => {
    disposed = true;
    clearTimeout(retry);
    socket?.close();
  };
}
