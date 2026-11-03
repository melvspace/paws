import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { ChatToolError } from "@paws/provider-core";
import type { makeBrowserService } from "./BrowserService.ts";
import { isAllowedRequestOrigin } from "./requestOrigin.ts";

export function browserSockets(
  server: Server,
  browsers: ReturnType<typeof makeBrowserService>,
  available: (agentId: string) => Promise<boolean>,
) {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
  });
  server.on("upgrade", (request, socket, head) => {
    const match = /^\/api\/agents\/([^/]+)\/browser\/stream$/.exec(
      (request.url ?? "").split("?")[0]!,
    );

    if (!match) {
      if (request.url !== "/ws") socket.destroy();

      return;
    }

    if (!isAllowedRequestOrigin(request.headers)) {
      socket.destroy();

      return;
    }

    void available(match[1]!)
      .then((allowed) => {
        if (!allowed) {
          socket.destroy();

          return;
        }

        sockets.handleUpgrade(request, socket, head, (client) => {
          let closed = false;
          client.send(
            JSON.stringify({ type: "status", message: "Preparing browser…" }),
          );

          // Attach a receiver before launch completes so initial input is retained.
          const observe =
            new URL(request.url!, "http://localhost").searchParams.get(
              "observe",
            ) === "1";
          const attached = observe
            ? browsers.observe(match[1]!, (message) => {
                if (client.readyState === 1)
                  client.send(JSON.stringify(message));
              })
            : browsers.attach(
                match[1]!,
                (message) => {
                  if (
                    client.readyState === 1 &&
                    (message.type !== "frame" ||
                      client.bufferedAmount < 2 * 1024 * 1024)
                  )
                    client.send(JSON.stringify(message));
                },
                () => client.close(1001, "Browser closed"),
              );
          const failed = (error: unknown) => {
            if (client.readyState === 1)
              client.send(
                JSON.stringify({
                  type: "error",
                  message:
                    error instanceof ChatToolError
                      ? error.message
                      : "Browser operation failed. Check the current tab and try again.",
                }),
              );
          };
          void attached.then(
            async (viewer) => {
              if (closed) await viewer.detach();
            },
            (error) => {
              failed(error);
              client.close(1011, "Browser unavailable");
            },
          );
          client.on("message", (data) => {
            void attached
              .then((viewer) => viewer.input(JSON.parse(data.toString())))
              .catch(failed);
          });
          client.on("error", () => client.close());
          client.on("close", () => {
            closed = true;
            void attached.then((viewer) => viewer.detach()).catch(() => {});
          });
        });
      })
      .catch(() => socket.destroy());
  });

  return {
    close() {
      for (const socket of sockets.clients) socket.terminate();

      sockets.close();
    },
  };
}
