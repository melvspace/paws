import { z } from "zod";
import { ChatExecutionError } from "@paws/provider-core";

const info = z.object({ version: z.string(), pid: z.number().int() });
const health = z.object({ version: z.string(), healthy: z.literal(true) });

// Adapted from T3 Code versionProbe.ts (MIT). Probe the running helper, not a cached catalog version.
export async function probeOpenCodeProtocol(
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  for (const path of ["/api/info", "/global/health"] as const) {
    let response: Response;
    let body: unknown;

    try {
      response = await fetch(new URL(path, baseUrl), {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        redirect: "error",
      });

      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();

        throw new ChatExecutionError(
          "The OpenCode server rejected its connection credentials.",
        );
      }

      // Both generations can serve an HTML fallback for the other generation's endpoint.
      if (
        !response.ok ||
        response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      ) {
        await response.body?.cancel();
        continue;
      }

      body = await response.json();
    } catch (error) {
      if (error instanceof ChatExecutionError) throw error;
      if (signal.aborted) throw signal.reason;
      if (error instanceof SyntaxError) continue;

      throw new ChatExecutionError(
        "Could not identify the running OpenCode server. Check its connection and try again.",
      );
    }

    const decoded = (path === "/api/info" ? info : health).safeParse(body);

    if (!decoded.success) continue;

    const major = /^(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/.exec(
      decoded.data.version,
    )?.[1];

    if (!major || Number(major) < 1) continue;

    return {
      generation: Number(major) >= 2 ? "v2" : "v1",
      version: decoded.data.version,
    };
  }

  throw new ChatExecutionError(
    "The server did not report a recognized OpenCode protocol. Check that the configured executable is a compatible OpenCode installation.",
  );
}
