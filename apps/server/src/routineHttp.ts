import { nextRoutineTime, validateTrigger } from "./routineSchedule.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Schema } from "effect";
import { SaveRoutine, RoutineTrigger } from "@paws/contracts";
import { chatHttp } from "./chatHttp.ts";
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
  try {
    const chatAlias =
      !ingressOnly &&
      /^\/api\/agents\/([^/]+)\/chat(?:\/(.*))?$/.exec(request.url ?? "");

    if (chatAlias) {
      const id = decodeURIComponent(chatAlias[1]!);

      try {
        service.getRun(id);
      } catch {
        return false;
      }

      const action = chatAlias[2];

      if (
        (request.method === "GET" &&
          (!action ||
            action === "skills" ||
            /^attachments\/[a-f0-9]{64}$/.test(action))) ||
        (request.method === "POST" && action === "uploads")
      )
        return chatHttp(request, response, service.conversations);

      // Execution mutations must pass through the routine lifecycle endpoints.
      response.writeHead(405).end(
        JSON.stringify({
          error: "Use the routine run respond, cancel, or retry endpoint.",
        }),
      );

      return true;
    }

    const preview = !ingressOnly && request.url === "/api/routine-preview";
    const url = new URL(request.url ?? "/", "http://localhost");
    const webhook = /^\/hooks\/routines\/([a-f0-9-]{36})$/.exec(url.pathname);
    const match =
      /^\/api\/agents\/([^/]+)\/routines(?:\/([a-f0-9-]{36})(?:\/(run|webhook))?)?$/.exec(
        url.pathname,
      );
    const run =
      /^\/api\/routine-runs\/([a-f0-9-]{36})(?:\/(cancel|retry|respond|details))?$/.exec(
        request.url ?? "",
      );

    if (!preview && !webhook && (ingressOnly || (!match && !run))) return false;

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

      const authorization = request.headers.authorization;
      const secret =
        typeof authorization === "string"
          ? (/^Bearer ([^\s]+)$/i.exec(authorization)?.[1] ?? null)
          : null;
      result = service.webhook(
        webhook[1]!,
        await body(request, service.limits.webhookBytes),
        secret,
      );
      response.writeHead(202).end(JSON.stringify(result));

      return true;
    }

    if (match) {
      const agentId = match[1]!;
      const id = match[2];
      const before = url.searchParams.get("before");
      const state = service.list(
        agentId,
        before === null ? undefined : Number(before),
      );

      if (id && !state.routines.some((item) => item.id === id))
        throw new ChatError(404, "Routine not found.");

      if (
        id &&
        match[3] === "webhook" &&
        ["GET", "POST"].includes(request.method ?? "")
      )
        result = service.webhookEndpoint(id, request.method === "POST");
      else if (request.method === "GET" && !id) result = state;
      else if (request.method === "DELETE" && id) {
        await service.remove(id);
        result = { deleted: true };
      } else if (request.method === "POST" && id && match[3] === "run") {
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
        const previous = state.routines.find((item) => item.id === id);
        result = {
          routine,
          ...(routine.trigger.kind === "webhook" &&
          previous?.trigger.kind !== "webhook"
            ? { webhook: service.webhookEndpoint(routine.id, true) }
            : {}),
        };
      } else throw new ChatError(405, "Method not allowed.");
    } else if (run) {
      const id = run[1]!;

      if (request.method === "GET" && run[2] === "details")
        result = service.getRun(id);
      else if (request.method === "GET" && !run[2])
        result = service.conversations.get(id);
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
