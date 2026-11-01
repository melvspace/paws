import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { join } from "node:path";
import type { TeamToolRequest, TeamIntegration } from "@paws/contracts";
import { ChatToolError } from "@paws/provider-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  authorizationPath,
  mcpAuthFailure,
  mcpFetch,
  TeamMcpAuth,
  withMcpLock,
} from "./teamMcpAuth.ts";

export async function remoteTeamMcp(
  root: string,
  teamId: string,
  integration: TeamIntegration,
  input: TeamToolRequest,
  secrets: Record<string, string>,
  signal: AbortSignal,
) {
  const directory = join(root, "team-auth", teamId, integration.id);

  return withMcpLock(directory, async () => {
    const provider = new TeamMcpAuth(directory, integration.url!);
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const transport = new StreamableHTTPClientTransport(
      new URL(integration.url!),
      {
        ...(!secrets.BEARER_TOKEN && provider.redirectUrl
          ? { authProvider: provider }
          : {}),
        requestInit: {
          headers: secrets.BEARER_TOKEN
            ? { Authorization: `Bearer ${secrets.BEARER_TOKEN}` }
            : {},
        },
        fetch: mcpFetch(timeout),
      },
    );
    const client = new Client({ name: "paws", version: "0.1.0" });
    const abort = () => {
      void client.close().catch(() => {});
    };
    timeout.addEventListener("abort", abort, { once: true });

    try {
      timeout.throwIfAborted();
      await client.connect(transport);
      const result =
        input.action === "tools"
          ? await client.listTools({}, { signal: timeout })
          : await client.callTool(
              { name: input.tool!, arguments: input.arguments ?? {} },
              undefined,
              { signal: timeout },
            );

      // Redact strings before JSON encoding so quoted credential values stay matched.
      return JSON.parse(
        JSON.stringify(result, (_key, value: unknown) => {
          if (typeof value !== "string") return value;

          let redacted = provider.redact(value);

          for (const secret of Object.values(secrets)) {
            if (secret) redacted = redacted.split(secret).join("[redacted]");
          }

          return redacted;
        }),
      );
    } catch (error) {
      if (
        error instanceof UnauthorizedError ||
        (error instanceof StreamableHTTPError && error.code === 401)
      ) {
        return {
          status: provider.failure()
            ? "authentication_failed"
            : "authentication_required",
          authorizationUrl: authorizationPath(teamId, integration.id),
          message:
            provider.failure() ??
            "Open this Paws sign-in link in your browser. After approving, retry tools. If this server uses a bearer token instead, configure BEARER_TOKEN through a private secret request.",
        };
      }

      if (error instanceof ChatToolError) throw error;
      if (error instanceof OAuthError) throw mcpAuthFailure(error);
      if (error instanceof StreamableHTTPError)
        throw new ChatToolError(
          `Remote MCP request failed${error.code ? ` (HTTP ${error.code})` : ""}. Check the server URL and access permissions.`,
        );

      throw new ChatToolError(
        timeout.aborted
          ? "Remote MCP request timed out or was cancelled."
          : "Remote MCP protocol or authentication failed. Check the endpoint and its supported authentication method.",
      );
    } finally {
      timeout.removeEventListener("abort", abort);
      await client.close().catch(() => {});
    }
  });
}
