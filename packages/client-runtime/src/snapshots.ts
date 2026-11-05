import { Schema } from "effect";
import { Snapshot } from "@paws/contracts";

export interface SnapshotConnection {
  snapshot: Snapshot;
  connected: boolean;
  error: string | null;
}

export function subscribeSnapshot(
  url: string,
  receive: (state: SnapshotConnection) => void,
) {
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket;
  let state: SnapshotConnection = {
    snapshot: { agents: [] },
    connected: false,
    error: null,
  };

  function publish(next: SnapshotConnection) {
    if (disposed) return;

    state = next;
    receive(state);
  }

  function connect() {
    socket = new WebSocket(url);
    socket.onmessage = (event) => {
      if (disposed) return;

      try {
        const snapshot = Schema.decodeUnknownSync(Snapshot)(
          JSON.parse(event.data),
        );
        publish({ snapshot, connected: true, error: null });
      } catch {
        publish({ ...state, error: "The server sent an invalid agent list." });
      }
    };
    socket.onerror = () =>
      publish({
        ...state,
        connected: false,
        error:
          "Could not connect to this environment. Check that it is online and still paired.",
      });
    socket.onclose = () => {
      if (disposed) return;

      publish({ ...state, connected: false });
      retry = setTimeout(connect, 2000);
    };
  }

  connect();

  return () => {
    disposed = true;
    clearTimeout(retry);
    socket.close();
  };
}
