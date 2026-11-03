import { Schema } from "effect";
import {
  BrowserServerMessage,
  type BrowserClientMessage,
} from "@paws/contracts";

export function connectBrowser(
  agentId: string,
  receive: (message: BrowserServerMessage) => void,
  connection: (connected: boolean) => void,
) {
  const url = new URL(
    `/api/agents/${encodeURIComponent(agentId)}/browser/stream`,
    window.location.href,
  );
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  let disposed = false;
  socket.onopen = () => {
    if (!disposed) connection(true);
  };
  socket.onclose = () => {
    if (!disposed) connection(false);
  };
  socket.onerror = () => {
    if (!disposed) connection(false);
  };
  socket.onmessage = (event) => {
    if (disposed) return;

    try {
      receive(
        Schema.decodeUnknownSync(BrowserServerMessage)(JSON.parse(event.data)),
      );
    } catch {
      receive({
        type: "error",
        message: "The browser sent an invalid update. Reconnect to try again.",
      });
    }
  };

  return {
    send(message: BrowserClientMessage) {
      if (socket.readyState !== WebSocket.OPEN) return false;

      socket.send(JSON.stringify(message));

      return true;
    },
    close() {
      disposed = true;
      socket.close();
    },
  };
}
