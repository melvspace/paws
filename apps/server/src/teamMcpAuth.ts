import { randomUUID } from "node:crypto";
import * as Fs from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TeamIntegration } from "@paws/contracts";
import { ChatToolError } from "@paws/provider-core";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { isAllowedRequestOrigin } from "./requestOrigin.ts";

const StoredAuth = Schema.Struct({
  serverUrl: Schema.String,
  redirectUrl: Schema.String,
  client: Schema.optional(Schema.Unknown),
  tokens: Schema.optional(Schema.Unknown),
  verifier: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
  authorizationUrl: Schema.optional(Schema.String),
  failure: Schema.optional(Schema.String),
});

export function authorizationPath(teamId: string, integrationId: string) {
  return `/api/teams/${teamId}/integrations/${integrationId}/authorize`;
}

// One integration owns one refresh token and one pending browser login.
const operations = new Map<string, Promise<unknown>>();

export async function withMcpLock<T>(key: string, run: () => Promise<T>) {
  const previous = operations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  operations.set(key, next);

  try {
    return await next;
  } finally {
    if (operations.get(key) === next) operations.delete(key);
  }
}

export class TeamMcpAuth implements OAuthClientProvider {
  private data: typeof StoredAuth.Type;
  private readonly path: string;
  readonly key: string;

  constructor(directory: string, serverUrl: string, redirectUrl = "") {
    this.key = directory;
    this.path = join(directory, "oauth.json");
    const stored = Fs.existsSync(this.path)
      ? Schema.decodeUnknownSync(StoredAuth)(
          JSON.parse(Fs.readFileSync(this.path, "utf8")),
        )
      : undefined;
    this.data =
      stored?.serverUrl === serverUrl &&
      (!redirectUrl || stored.redirectUrl === redirectUrl)
        ? stored
        : { serverUrl, redirectUrl };
  }

  get redirectUrl() {
    return this.data.redirectUrl || undefined;
  }

  get clientMetadata() {
    return {
      client_name: "Paws",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  private save(patch: Partial<typeof StoredAuth.Type>) {
    this.data = { ...this.data, ...patch };
    Fs.mkdirSync(this.key, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;

    try {
      Fs.writeFileSync(temporary, JSON.stringify(this.data), {
        mode: 0o600,
        flag: "wx",
      });
      Fs.renameSync(temporary, this.path);
    } finally {
      Fs.rmSync(temporary, { force: true });
    }
  }

  clientInformation() {
    return this.data.client
      ? OAuthClientInformationFullSchema.parse(this.data.client)
      : undefined;
  }

  saveClientInformation(
    client: Parameters<
      NonNullable<OAuthClientProvider["saveClientInformation"]>
    >[0],
  ) {
    this.save({ client });
  }

  tokens() {
    return this.data.tokens
      ? OAuthTokensSchema.parse(this.data.tokens)
      : undefined;
  }

  saveTokens(tokens: Parameters<OAuthClientProvider["saveTokens"]>[0]) {
    this.save({ tokens, failure: undefined });
  }

  state() {
    const state = randomUUID();
    this.save({ state, expiresAt: Date.now() + 10 * 60_000 });

    return state;
  }

  redirectToAuthorization(url: URL) {
    if (!this.redirectUrl) throw new Error("Browser sign-in is required.");

    this.save({ authorizationUrl: url.href });
  }

  saveCodeVerifier(verifier: string) {
    this.save({ verifier });
  }

  codeVerifier() {
    if (!this.data.verifier) throw new Error("Sign-in expired. Start again.");

    return this.data.verifier;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ) {
    if (scope === "all" || scope === "client") this.save({ client: undefined });
    if (scope === "all" || scope === "tokens") this.save({ tokens: undefined });
    if (scope === "all" || scope === "verifier")
      this.save({ verifier: undefined });
  }

  failure() {
    return this.data.failure;
  }

  saveFailure(error?: unknown) {
    this.save({
      failure: error === undefined ? undefined : mcpAuthFailure(error).message,
    });
  }

  pending() {
    return this.data.expiresAt &&
      this.data.expiresAt > Date.now() &&
      this.data.state &&
      this.data.authorizationUrl
      ? { state: this.data.state, url: this.data.authorizationUrl }
      : undefined;
  }

  consume(state: string, cookie: string | undefined, issuer: string | null) {
    const pending = this.pending();

    if (
      !pending ||
      state !== pending.state ||
      cookie !== state ||
      (issuer !== null && issuer !== this.clientInformation()?.issuer)
    ) {
      throw new ChatToolError(
        "Sign-in expired or invalid. Start sign-in again.",
      );
    }

    this.save({
      state: undefined,
      authorizationUrl: undefined,
      expiresAt: undefined,
    });
  }

  redact(text: string) {
    const tokens = this.tokens();
    const client = this.clientInformation();

    for (const secret of [
      tokens?.access_token,
      tokens?.refresh_token,
      client?.client_secret,
      this.data.verifier,
    ]) {
      if (secret) text = text.split(secret).join("[redacted]");
    }

    return text;
  }
}

// Return protocol/status diagnostics, never remote bodies that may echo credentials.
export function mcpFetch(signal: AbortSignal) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    let response: Response;

    try {
      response = await fetch(input, {
        ...init,
        signal: AbortSignal.any([
          signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
    } catch {
      throw new ChatToolError(
        signal.aborted
          ? "Remote MCP request timed out or was cancelled."
          : "Remote MCP connection failed. Check its URL and network access.",
      );
    }

    // 401 starts OAuth; 404/405 allow SDK discovery and transport fallbacks.
    if (!response.ok && ![401, 404, 405].includes(response.status)) {
      let code = "";

      try {
        const body: unknown = await response.clone().json();

        if (
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string" &&
          /^[a-z_]{1,64}$/.test(body.error)
        ) {
          code = `, ${body.error}`;
        }
      } catch {
        /* Non-JSON error bodies are not exposed. */
      }

      // OAuth errors must reach the SDK so expired grants can refresh/re-authorize.
      if (code) return response;

      throw new ChatToolError(
        `Remote MCP request failed (HTTP ${response.status}).`,
      );
    }

    return response;
  };
}

export async function teamMcpAuthHttp(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  findIntegration: (
    teamId: string,
    integrationId: string,
  ) => Promise<TeamIntegration | undefined>,
) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const match =
    /^\/api\/teams\/([a-f0-9-]{36})\/integrations\/([a-z][a-z0-9-]{0,63})\/authorize(\/callback)?$/.exec(
      url.pathname,
    );

  if (!match || request.method !== "GET") return false;

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  const [, teamId, integrationId, callback] = match;
  const origin = `http://${request.headers.host}`;

  // Callback navigations arrive cross-site; only this route uses OAuth state + cookie
  // instead of the ordinary same-origin check. Host still must identify this machine.
  if (
    !isAllowedRequestOrigin({ origin }) ||
    (!callback && !isAllowedRequestOrigin(request.headers))
  ) {
    response.writeHead(403).end("Origin not allowed");

    return true;
  }

  const integration = await findIntegration(teamId!, integrationId!);

  if (integration?.kind !== "mcp-http" || !integration.url) {
    response.writeHead(404).end("Integration not found.");

    return true;
  }

  const directory = join(root, "team-auth", teamId!, integrationId!);
  const path = authorizationPath(teamId!, integrationId!);
  const cookieName = `paws-oauth-${teamId}-${integrationId}`;
  await withMcpLock(directory, async () => {
    const provider = new TeamMcpAuth(
      directory,
      integration.url!,
      `${origin}${path}/callback`,
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(integration.url!),
      {
        authProvider: provider,
        fetch: mcpFetch(AbortSignal.timeout(60_000)),
      },
    );
    const client = new Client({ name: "paws", version: "0.1.0" });

    try {
      if (callback) {
        const cookie = request.headers.cookie
          ?.split("; ")
          .find((item) => item.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
        provider.consume(
          url.searchParams.get("state") ?? "",
          cookie,
          url.searchParams.get("iss"),
        );
        response.setHeader(
          "Set-Cookie",
          `${cookieName}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0`,
        );

        if (url.searchParams.has("error")) {
          provider.invalidateCredentials("verifier");
          response
            .writeHead(400)
            .end("Sign-in was declined. Return to Paws to retry.");

          return;
        }

        const code = url.searchParams.get("code");

        if (!code)
          throw new ChatToolError(
            "Authorization code missing. Start sign-in again.",
          );

        try {
          await transport.finishAuth(code);
        } finally {
          provider.invalidateCredentials("verifier");
        }

        response.end("Connected. You can return to Paws.");

        return;
      }

      provider.saveFailure();

      if (!provider.pending()) {
        try {
          await client.connect(transport);
          response.end("Already connected. You can return to Paws.");

          return;
        } catch (error) {
          if (!(error instanceof UnauthorizedError) || !provider.pending())
            throw error;
        }
      }

      const pending = provider.pending()!;
      response.setHeader(
        "Set-Cookie",
        `${cookieName}=${pending.state}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=600`,
      );
      response.writeHead(302, { Location: pending.url }).end();
    } catch (error) {
      // Invalid callbacks cannot overwrite a valid pending sign-in or saved login.
      if (!callback) provider.saveFailure(error);

      response.writeHead(400).end(mcpAuthFailure(error).message);
    } finally {
      await client.close().catch(() => {});
    }
  });

  return true;
}

export function mcpAuthFailure(error: unknown) {
  if (error instanceof ChatToolError) return error;
  if (error instanceof OAuthError)
    return new ChatToolError(
      `Remote MCP authentication failed (${error.errorCode}). The server may require an approved OAuth client or different access permissions.`,
    );

  return new ChatToolError(
    "MCP sign-in could not complete. The server may require a registered OAuth client or a bearer token.",
  );
}
