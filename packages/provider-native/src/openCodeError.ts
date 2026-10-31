import { z } from "zod";
import { ChatExecutionError } from "@paws/provider-core";

// Follow T3 Code's typed failure translation; never expose response bodies,
// credentials, or arbitrary provider diagnostic messages through the UI.
export function openCodeError(value: unknown): ChatExecutionError {
  const parsed = z
    .object({ type: z.string().optional(), status: z.number().optional() })
    .safeParse(value);
  const error = parsed.success ? parsed.data : undefined;

  if (error?.type === "provider.free-limit")
    return new ChatExecutionError(
      "OpenCode's free usage limit has been reached. Switch to another provider or model, connect your own provider account, or wait for the free quota to reset.",
    );

  if (error?.status === 402)
    return new ChatExecutionError(
      "The model provider has no available balance or requires billing. Check that provider's billing settings or switch providers. Retrying immediately will not resolve this.",
    );

  if (error?.type === "provider.quota")
    return new ChatExecutionError(
      "The model provider's usage quota has been reached. Wait for the quota to reset, check your provider plan, or switch providers or models.",
    );

  if (error?.type === "provider.rate-limit" || error?.status === 429)
    return new ChatExecutionError(
      "The model provider is rate limiting requests. Wait before retrying, or switch providers or models.",
    );

  if (error?.status === 401 || error?.status === 403)
    return new ChatExecutionError(
      "The model provider rejected access. Check its sign-in, API key, and model permissions in provider settings, then retry.",
    );

  return new ChatExecutionError(
    "OpenCode could not finish this reply. Check its provider connection and settings, then retry.",
  );
}
