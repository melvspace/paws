import type { IncomingMessage, ServerResponse } from "node:http";
import { Effect, Schema } from "effect";
import { SendChat, ChatQueueAction } from "@paws/contracts";
import { ChatError, type makeChatService } from "./ChatService.ts";

export async function chatHttp(
  request: IncomingMessage,
  response: ServerResponse,
  chat: ReturnType<typeof makeChatService>,
) {
  const match =
    /^\/api\/agents\/([^/]+)\/chat(?:\/(stop|compact|continue|queue|skills|uploads|attachments\/([a-f0-9]{64})))?$/.exec(
      request.url ?? "",
    );

  if (!match) return false;

  try {
    const id = decodeURIComponent(match[1]!);
    let result;

    if (request.method === "POST" && match[2] === "uploads") {
      if (request.headers["content-type"] !== "application/octet-stream")
        throw new ChatError(415, "Expected a file upload.");

      chat.get(id);
      const header = request.headers["x-filename"];

      if (typeof header !== "string")
        throw new ChatError(400, "Filename required.");

      const chunks: Buffer[] = [];
      let size = 0;

      for await (const chunk of request) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;

        if (size > 64 * 1024 * 1024)
          throw new ChatError(413, "Files must be 64 MB or smaller.");

        chunks.push(data);
      }

      const outcome = await Effect.runPromise(
        Effect.result(
          chat.upload(id, decodeURIComponent(header), Buffer.concat(chunks)),
        ),
      );

      if (outcome._tag === "Failure") throw outcome.failure.cause;

      response.writeHead(201).end(JSON.stringify(outcome.success));

      return true;
    }

    if (request.method === "GET" && match[3]) {
      const attachment = await chat.attachment(id, match[3]);
      response.setHeader("Content-Type", attachment.mediaType);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader(
        "Cache-Control",
        "private, max-age=31536000, immutable",
      );
      response.setHeader(
        "Content-Disposition",
        `${/^(image|audio|video)\//.test(attachment.mediaType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16)}`)}`,
      );
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; sandbox",
      );
      response.setHeader("Accept-Ranges", "bytes");
      const size = attachment.data.length;
      const range = request.headers.range;

      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const start = match?.[1]
          ? Number(match[1])
          : Math.max(0, size - Number(match?.[2]));
        const end =
          match?.[1] && match[2]
            ? Math.min(size - 1, Number(match[2]))
            : size - 1;

        if (
          !match ||
          (!match[1] && !match[2]) ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start > end ||
          start >= size
        ) {
          response.setHeader("Content-Range", `bytes */${size}`);
          response.writeHead(416).end();

          return true;
        }

        response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        response.setHeader("Content-Length", end - start + 1);
        response.writeHead(206).end(attachment.data.subarray(start, end + 1));
      } else {
        response.setHeader("Content-Length", size);
        response.end(attachment.data);
      }

      return true;
    }

    if (request.method === "GET" && match[2] === "skills") {
      const outcome = await Effect.runPromise(Effect.result(chat.skills(id)));

      if (outcome._tag === "Failure") throw outcome.failure.cause;

      result = outcome.success;
    } else if (request.method === "GET" && !match[2]) result = chat.get(id);
    else if (request.method === "POST" && match[2] === "stop")
      result = await chat.stop(id);
    else if (
      request.method === "POST" &&
      ["compact", "continue"].includes(match[2] ?? "")
    ) {
      const outcome = await Effect.runPromise(
        Effect.result(
          match[2] === "compact"
            ? chat.compact(id)
            : chat.continueInterrupted(id),
        ),
      );

      if (outcome._tag === "Failure") {
        const failure = outcome.failure;

        throw failure.cause;
      }

      result = outcome.success;
    } else if (
      request.method === "POST" &&
      (!match[2] || match[2] === "queue")
    ) {
      if (request.headers["content-type"] !== "application/json")
        throw new ChatError(415, "Expected application/json.");

      let body = "";

      for await (const chunk of request) {
        body += chunk;

        if (Buffer.byteLength(body) > 65536)
          throw new ChatError(413, "Message too large.");
      }

      const data: unknown = JSON.parse(body);
      const outcome = await Effect.runPromise(
        Effect.result(
          match[2] === "queue"
            ? chat.updateQueue(
                id,
                Schema.decodeUnknownSync(ChatQueueAction)(data),
              )
            : chat.send(id, Schema.decodeUnknownSync(SendChat)(data)),
        ),
      );

      if (outcome._tag === "Failure") throw outcome.failure.cause;

      result = outcome.success;
    } else {
      throw new ChatError(405, "Method not allowed.");
    }

    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(error instanceof ChatError ? error.status : 400).end(
      JSON.stringify({
        error:
          error instanceof ChatError
            ? error.message
            : "Could not process this message.",
      }),
    );
  }

  return true;
}
