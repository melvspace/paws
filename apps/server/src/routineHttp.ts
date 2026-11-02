import { nextRoutineTime, validateTrigger } from "./routineSchedule.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Schema } from "effect";
import { SaveRoutine, RoutineTrigger } from "@paws/contracts";
import { ChatError } from "./ChatService.ts";
import type { makeRoutineService } from "./RoutineService.ts";

async function body(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;

    if (size > limit) throw new ChatError(413, "Request too large.");

    chunks.push(data);
  }

  return Buffer.concat(chunks);
}

export async function routineHttp(
  request: IncomingMessage,
  response: ServerResponse,
  service: ReturnType<typeof makeRoutineService>,
  ingressOnly = false,
) {
  const preview = !ingressOnly && request.url === "/api/routine-preview";
  const webhook = /^\/hooks\/routines\/([a-f0-9-]{36})$/.exec(
    request.url ?? "",
  );
  const match =
    /^\/api\/agents\/([^/]+)\/routines(?:\/([a-f0-9-]{36})(?:\/(run|rotate))?)?$/.exec(
      request.url ?? "",
    );
  const run =
    /^\/api\/routine-runs\/([a-f0-9-]{36})(?:\/(cancel|retry|respond))?$/.exec(
      request.url ?? "",
    );

  if (!preview && !webhook && (ingressOnly || (!match && !run))) return false;

  try {
    let result: unknown;

    if (preview) {
      if (request.method !== "POST") throw new ChatError(405, "Use POST.");

      const input = Schema.decodeUnknownSync(
        Schema.Struct({ trigger: RoutineTrigger }),
      )(JSON.parse((await body(request, 65536)).toString()));
      validateTrigger(input.trigger);
      const times: string[] = [];
      let after = Date.now();

      for (let index = 0; index < 3; index++) {
        const next = nextRoutineTime(input.trigger, after);

        if (!next) break;

        times.push(next);
        after = Date.parse(next);
      }

      response.end(JSON.stringify(times));

      return true;
    }

    if (webhook) {
      if (request.method !== "POST") throw new ChatError(405, "Use POST.");

      result = service.webhook(
        webhook[1]!,
        request.headers,
        await body(request, service.limits.webhookBytes),
      );
      response.writeHead(202).end(JSON.stringify(result));

      return true;
    }

    if (match) {
      const agentId = match[1]!;
      const id = match[2];
      const state = service.list(agentId);

      if (id && !state.routines.some((item) => item.id === id))
        throw new ChatError(404, "Routine not found.");

      if (request.method === "GET" && !id) result = state;
      else if (request.method === "DELETE" && id) {
        await service.remove(id);
        result = { deleted: true };
      } else if (request.method === "POST" && id && match[3] === "rotate")
        result = service.rotate(id);
      else if (request.method === "POST" && id && match[3] === "run") {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({ payload: Schema.optional(Schema.String) }),
        )(JSON.parse((await body(request, 300000)).toString()));
        result = service.enqueue(id, "manual", input.payload);
      } else if (
        (request.method === "POST" && !id) ||
        (request.method === "PATCH" && id && !match[3])
      ) {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({
            routine: SaveRoutine,
            revision: Schema.optional(Schema.Number),
          }),
        )(JSON.parse((await body(request, 65536)).toString()));
        const routine = service.save(
          agentId,
          input.routine,
          id,
          "user",
          input.revision,
        );
        result = {
          routine,
          ...(routine.trigger.kind === "webhook" &&
          (!id ||
            state.routines.find((item) => item.id === id)?.trigger.kind !==
              "webhook")
            ? { webhook: service.rotate(routine.id) }
            : {}),
        };
      } else throw new ChatError(405, "Method not allowed.");
    } else if (run) {
      const id = run[1]!;
      const conversation = service.conversations.get(id);

      if (request.method === "GET" && !run[2]) result = conversation;
      else if (request.method === "POST" && run[2] === "cancel") {
        await service.cancel(id);
        result = { cancelled: true };
      } else if (request.method === "POST" && run[2] === "respond") {
        await service.respond(
          id,
          JSON.parse((await body(request, 65536)).toString()),
        );
        result = { accepted: true };
      } else if (request.method === "POST" && run[2] === "retry") {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({
            routineId: Schema.String,
            payload: Schema.optional(Schema.String),
          }),
        )(JSON.parse((await body(request, 300000)).toString()));
        // Verify the source belongs to this routine before linking a retry.
        const original = service.getRun(id);

        if (
          !["failed", "interrupted", "expired", "cancelled"].includes(
            original.status,
          )
        )
          throw new ChatError(
            409,
            "Only failed, interrupted or cancelled work can be retried.",
          );

        if (!original || original.routineId !== input.routineId)
          throw new ChatError(400, "Retry source does not match this routine.");

        result = service.enqueue(input.routineId, "retry", input.payload, id);
      } else throw new ChatError(405, "Method not allowed.");
    }

    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(error instanceof ChatError ? error.status : 400).end(
      JSON.stringify({
        error:
          error instanceof ChatError
            ? error.message
            : "Check routine fields, schedule, and JSON payload.",
      }),
    );
  }

  return true;
}
