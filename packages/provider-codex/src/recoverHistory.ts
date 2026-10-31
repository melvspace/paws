import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { codexContextUsage } from "./contextUsage.ts";
import { Schema } from "effect";

const Event = Schema.Struct({
  timestamp: Schema.String,
  type: Schema.Literal("event_msg"),
  payload: Schema.Struct({
    type: Schema.Literal("item_completed"),
    thread_id: Schema.String,
    item: Schema.Struct({
      type: Schema.Literal("Extension"),
      kind: Schema.Literal("image_gen.generation"),
      id: Schema.String,
      status: Schema.Literal("completed"),
      savedPath: Schema.String,
      failure: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
});

const UsageEvent = Schema.Struct({
  type: Schema.Literal("event_msg"),
  payload: Schema.Struct({
    type: Schema.Literal("token_count"),
    info: Schema.Struct({
      last_token_usage: Schema.Struct({ total_tokens: Schema.Number }),
      total_token_usage: Schema.Struct({ total_tokens: Schema.Number }),
      model_context_window: Schema.NullOr(Schema.Number),
    }),
  }),
});

// Recover completed images from existing native history without replaying a turn.
export async function* recoverCodexHistory(home: string, threadId: string) {
  const sessions = join(home, ".codex/sessions");
  const files = await readdir(sessions, { recursive: true }).catch(() => []);

  for (const file of files.filter((name) =>
    name.endsWith(`-${threadId}.jsonl`),
  )) {
    const stream = createReadStream(join(sessions, file), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of lines) {
        let event;

        try {
          const usage = Schema.decodeUnknownSync(UsageEvent)(JSON.parse(line))
            .payload.info;
          yield {
            type: "usage" as const,
            usage: codexContextUsage({
              last: { totalTokens: usage.last_token_usage.total_tokens },
              total: { totalTokens: usage.total_token_usage.total_tokens },
              modelContextWindow: usage.model_context_window,
            }),
          };

          continue;
        } catch {
          // Other native events can carry images rather than usage.
        }

        try {
          event = Schema.decodeUnknownSync(Event)(JSON.parse(line));
        } catch {
          continue;
        }

        if (
          event.payload.thread_id === threadId &&
          !event.payload.item.failure
        ) {
          yield {
            type: "image" as const,
            id: event.payload.item.id,
            savedPath: event.payload.item.savedPath,
            createdAt: event.timestamp,
          };
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
}
