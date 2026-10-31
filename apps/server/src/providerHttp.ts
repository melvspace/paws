import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect, Schema } from "effect";
import {
  CreateProvider,
  UpdateProvider,
  UpdateProviderEnvironment,
} from "@paws/contracts";
import type { makeProviderService } from "./ProviderService.ts";

export async function providerHttp(
  request: IncomingMessage,
  response: ServerResponse,
  providers: ReturnType<typeof makeProviderService>,
): Promise<boolean> {
  if (!request.url?.startsWith("/api/providers")) return false;

  const match =
    /^\/api\/providers(?:\/([^/]+)(?:\/(refresh|environment|signin|cancel-signin))?)?$/.exec(
      request.url,
    );

  if (!match) {
    response.writeHead(404).end(JSON.stringify({ error: "Not found" }));

    return true;
  }

  const id = match[1];
  let result: unknown;

  try {
    if (request.method === "GET" && !id) {
      result = { providers: providers.list() };
    } else if (request.method === "POST" && id && match[2] === "signin") {
      result = providers.startSignIn(id);
    } else if (
      request.method === "POST" &&
      id &&
      match[2] === "cancel-signin"
    ) {
      result = providers.cancelSignIn(id);
    } else if (request.method === "POST" && id && match[2] === "refresh") {
      result = await providers.refresh(id);
    } else if (
      (request.method === "POST" && !id) ||
      (request.method === "PATCH" &&
        id &&
        (!match[2] || match[2] === "environment"))
    ) {
      if (request.headers["content-type"] !== "application/json") {
        response
          .writeHead(415)
          .end(JSON.stringify({ error: "Expected application/json" }));

        return true;
      }

      let body = "";

      for await (const chunk of request) {
        body += chunk;

        if (Buffer.byteLength(body) > 65536) {
          response
            .writeHead(413)
            .end(JSON.stringify({ error: "Request too large" }));

          return true;
        }
      }

      const input: unknown = JSON.parse(body);
      result =
        id && match[2] === "environment"
          ? await Effect.runPromise(
              providers.setEnvironment(
                id,
                Schema.decodeUnknownSync(UpdateProviderEnvironment)(input),
              ),
            )
          : id
            ? await Effect.runPromise(
                providers.update(
                  id,
                  Schema.decodeUnknownSync(UpdateProvider)(input),
                ),
              )
            : await Effect.runPromise(
                providers.create(
                  Schema.decodeUnknownSync(CreateProvider)(input).driver,
                ),
              );
    } else {
      response
        .writeHead(405)
        .end(JSON.stringify({ error: "Method not allowed" }));

      return true;
    }

    response
      .writeHead(result === null ? 404 : 200)
      .end(JSON.stringify(result ?? { error: "Provider not found" }));
  } catch {
    response.writeHead(400).end(
      JSON.stringify({
        error: "Could not update providers. Check the configuration.",
      }),
    );
  }

  return true;
}
