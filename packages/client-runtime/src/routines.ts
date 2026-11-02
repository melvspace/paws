import { Schema } from "effect";
import {
  Conversation,
  RoutineState,
  RoutineRun,
  Routine,
  type SaveRoutine,
  type SendChat,
} from "@paws/contracts";

export async function routineRequest(
  path: string,
  method = "GET",
  input?: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(path, {
    method,
    signal: signal ?? null,
    ...(input !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      : {}),
  });
  const data: unknown = await response.json();

  if (!response.ok) {
    const error = Schema.decodeUnknownSync(
      Schema.Struct({ error: Schema.String }),
    )(data);

    throw new Error(error.error);
  }

  return data;
}

export const routinePath = (agentId: string, id?: string) =>
  `/api/agents/${encodeURIComponent(agentId)}/routines${id ? `/${encodeURIComponent(id)}` : ""}`;
export async function loadRoutines(
  agentId: string,
  signal?: AbortSignal,
  before?: number,
) {
  const path = `${routinePath(agentId)}${before === undefined ? "" : `?before=${before}`}`;

  return Schema.decodeUnknownSync(RoutineState)(
    await routineRequest(path, "GET", undefined, signal),
  );
}
export async function loadRoutineRun(id: string, signal?: AbortSignal) {
  return Schema.decodeUnknownSync(RoutineRun)(
    await routineRequest(
      `/api/routine-runs/${encodeURIComponent(id)}/details`,
      "GET",
      undefined,
      signal,
    ),
  );
}
export async function saveRoutine(
  agentId: string,
  routine: SaveRoutine,
  id?: string,
  revision?: number,
) {
  return Schema.decodeUnknownSync(
    Schema.Struct({
      routine: Routine,
      webhook: Schema.optional(
        Schema.Struct({ endpoint: Schema.String, secret: Schema.String }),
      ),
    }),
  )(
    await routineRequest(routinePath(agentId, id), id ? "PATCH" : "POST", {
      routine,
      revision,
    }),
  );
}
export async function loadRoutineConversation(
  id: string,
  signal?: AbortSignal,
) {
  return Schema.decodeUnknownSync(Conversation)(
    await routineRequest(`/api/routine-runs/${id}`, "GET", undefined, signal),
  );
}
export async function respondToRoutine(id: string, input: SendChat) {
  await routineRequest(`/api/routine-runs/${id}/respond`, "POST", input);
}
