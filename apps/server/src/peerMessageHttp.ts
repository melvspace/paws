import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect } from "effect";
import { ChatError } from "./ChatError.ts";
import type { makeTeamworkService } from "./TeamworkService.ts";

export async function peerMessageHttp(
  request: IncomingMessage,
  response: ServerResponse,
  service: ReturnType<typeof makeTeamworkService>,
) {
  const match = /^\/api\/agents\/([^/]+)\/peer-messages\/([^/]+)\/retry$/.exec(
    request.url ?? "",
  );

  if (!match) return false;

  try {
    if (request.method !== "POST")
      throw new ChatError(405, "Use POST to retry a request.");

    const actor = decodeURIComponent(match[1]!);
    const eventId = decodeURIComponent(match[2]!);
    const result = await Effect.runPromise(
      Effect.result(service.execute(actor, { action: "retry", eventId })),
    );

    if (result._tag === "Failure") throw result.failure;

    const retry = result.success.events.find(
      (event) => event.retryOf === eventId,
    );

    if (!retry)
      throw new ChatError(
        409,
        "Could not confirm the retry. Check the latest message.",
      );

    response.writeHead(202).end(JSON.stringify({ requestId: retry.id }));
  } catch (error) {
    response.writeHead(error instanceof ChatError ? error.status : 400).end(
      JSON.stringify({
        error:
          error instanceof ChatError
            ? error.message
            : "Could not retry this request. Check your connection and try again.",
      }),
    );
  }

  return true;
}
