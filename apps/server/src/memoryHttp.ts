import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect, Schema } from "effect";
import { MemoryRequest } from "@paws/contracts";
import { makeMemoryService } from "./MemoryService.ts";

export async function memoryHttp(
  request: IncomingMessage,
  response: ServerResponse,
  service: ReturnType<typeof makeMemoryService>,
) {
  const match = /^\/api\/(agents|teams)\/([^/]+)\/memories$/.exec(
    request.url ?? "",
  );

  if (!match) return false;

  try {
    let input: MemoryRequest = { action: "list" };

    if (request.method === "POST") {
      if (request.headers["content-type"] !== "application/json") {
        response.writeHead(415).end(JSON.stringify({ error: "Use JSON." }));

        return true;
      }

      let body = "";

      for await (const chunk of request) {
        body += chunk;

        if (Buffer.byteLength(body) > 131072)
          throw new Error("Request too large.");
      }

      input = Schema.decodeUnknownSync(MemoryRequest)(JSON.parse(body));

      if (input.action !== "delete" && input.action !== "list") {
        response.writeHead(403).end(
          JSON.stringify({
            error: "Agents manage memory entries. Users can only delete them.",
          }),
        );

        return true;
      }
    } else if (request.method !== "GET") {
      response
        .writeHead(405)
        .end(JSON.stringify({ error: "Use GET or POST." }));

      return true;
    }

    const entries = await Effect.runPromise(
      service.execute(
        {
          kind: match[1] === "agents" ? "agents" : "teams",
          id: decodeURIComponent(match[2]!),
        },
        input,
      ),
    );
    response.end(JSON.stringify(entries));
  } catch (cause) {
    response.writeHead(400).end(
      JSON.stringify({
        error:
          cause instanceof Error ? cause.message : "Memory operation failed.",
      }),
    );
  }

  return true;
}
