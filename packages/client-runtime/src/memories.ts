import { environmentFetch } from "./transport.ts";
import { Schema } from "effect";
import { MemoryEntry, type MemoryRequest } from "@paws/contracts";

export async function memoryRequest(
  kind: "agents" | "teams",
  ownerId: string,
  input?: MemoryRequest,
  signal?: AbortSignal,
) {
  const response = await environmentFetch(
    `/api/${kind}/${encodeURIComponent(ownerId)}/memories`,
    {
      method: input ? "POST" : "GET",
      signal: signal ?? null,
      ...(input
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }
        : {}),
    },
  );
  const data: unknown = await response.json();

  if (!response.ok) {
    const error = Schema.decodeUnknownSync(
      Schema.Struct({ error: Schema.String }),
    )(data);

    throw new Error(error.error);
  }

  return Schema.decodeUnknownSync(Schema.Array(MemoryEntry))(data);
}
