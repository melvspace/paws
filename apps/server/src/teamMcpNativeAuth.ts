import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TeamIntegration } from "@paws/contracts";
import { ChatToolError, type McpHarnessClient } from "@paws/provider-core";
import { rememberedMcpHarness, type TeamMcpHarness } from "./teamMcpHarness.ts";
import { isAllowedSignInRequest } from "./requestOrigin.ts";

interface Login {
  id: string;
  url: string;
  serverUrl: string;
  abort: AbortController;
  callback: (url: string) => void;
  done: Promise<void>;
  failure?: string | undefined;
}

const logins = new Map<
  string,
  { ready: Promise<Login>; abort: AbortController; done: Promise<void> }
>();

async function startLogin(
  key: string,
  serverUrl: string,
  client: McpHarnessClient,
) {
  const existing = logins.get(key);

  if (existing) {
    const login = await existing.ready;

    if (
      login.serverUrl === serverUrl &&
      !login.abort.signal.aborted &&
      !login.failure
    )
      return login;

    login.abort.abort();
    await login.done.catch(() => {});
    logins.delete(key);
  }

  const abort = new AbortController();
  const signal = AbortSignal.any([
    abort.signal,
    AbortSignal.timeout(10 * 60_000),
  ]);
  const callback = Promise.withResolvers<string>();
  const ready = Promise.withResolvers<Login>();
  let login: Login | undefined;
  const done = Promise.resolve()
    .then(() =>
      client.authenticate(
        (url) => {
          login = {
            id: randomUUID(),
            url,
            serverUrl,
            abort,
            callback: callback.resolve,
            done,
          };
          ready.resolve(login);
        },
        callback.promise,
        signal,
      ),
    )
    .catch((error: unknown) => {
      const message =
        error instanceof ChatToolError
          ? error.message
          : "Harness sign-in stopped or expired. Start sign-in again.";

      if (login) login.failure = message;

      ready.reject(new ChatToolError(message));

      throw new ChatToolError(message);
    });
  void done.catch(() => {});
  const pending = ready.promise.catch((error) => {
    if (logins.get(key)?.ready === pending) logins.delete(key);

    throw error;
  });
  logins.set(key, { ready: pending, abort, done });

  return pending;
}

export async function closeNativeMcpLogins(
  root: string,
  teamId?: string,
  keep?: readonly string[],
) {
  const prefix = join(root, "team-auth", ...(teamId ? [teamId] : [])) + "/";

  for (const [key, value] of logins) {
    if (!key.startsWith(prefix) || keep?.some((id) => key === join(prefix, id)))
      continue;

    // A not-yet-ready launch must also be cancelled during shutdown.
    value.abort.abort();
    await value.done.catch(() => {});

    logins.delete(key);
  }
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

function loginPage(path: string, login: Login) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Sign in</title><style>
:root{color-scheme:dark;font:15px system-ui}body{max-width:480px;margin:10vh auto;padding:24px;background:#101010;color:#eee}h1{font-size:22px}p{line-height:1.5;color:#aaa}a{color:#80b4ff}form,label{display:grid;gap:12px}input,button{font:inherit;padding:12px;border:1px solid #444;border-radius:6px;background:#191919;color:inherit}button{cursor:pointer}input:focus{outline:2px solid #80b4ff}
</style></head><body>
<h1>Sign in</h1>
<p><a href="${escape(login.url)}" target="_blank" rel="noopener noreferrer">Open authorization</a></p>
<p>After approval, paste the final browser address here—even if that page cannot load. Keep it out of chat.</p>
<form method="post" action="${escape(path)}"><input type="hidden" name="session" value="${login.id}">
<label>Callback URL <input type="password" name="callback" required autocomplete="off"></label><button>Connect</button></form>
</body></html>`;
}

export async function nativeMcpAuthHttp(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  findIntegration: (
    teamId: string,
    integrationId: string,
  ) => Promise<TeamIntegration | undefined>,
  findHarness: (providerId: string) => TeamMcpHarness | undefined,
) {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const match =
    /^\/api\/teams\/([a-f0-9-]{36})\/integrations\/([a-z][a-z0-9-]{0,63})\/authorize$/.exec(
      path,
    );

  if (!match || !["GET", "POST"].includes(request.method ?? "")) return false;

  const [, teamId, integrationId] = match;
  const integration = await findIntegration(teamId!, integrationId!);

  if (integration?.kind !== "mcp-http" || !integration.url) return false;

  const providerId = await rememberedMcpHarness(root, teamId!, integration);

  if (!providerId) return false;

  response.setHeader("Cache-Control", "no-store");
  // Preserve the same-origin form Origin header while withholding cross-site referrers.
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );

  if (!isAllowedSignInRequest(request.headers, request.method)) {
    response.writeHead(403).end("Origin not allowed");

    return true;
  }

  const key = join(root, "team-auth", teamId!, integrationId!);
  const cookieName = `paws-native-${teamId}-${integrationId}`;

  try {
    const harness = findHarness(providerId);

    if (!harness)
      throw new ChatToolError(
        "The selected harness is unavailable. Enable it in Settings or ask an agent using another harness to connect.",
      );

    if (request.method === "GET") {
      const login = await startLogin(
        key,
        integration.url,
        harness.client(teamId!, integration, {}),
      );
      response.setHeader(
        "Set-Cookie",
        `${cookieName}=${login.id}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=600`,
      );
      response.end(loginPage(path, login));

      return true;
    }

    let body = "";

    for await (const chunk of request) {
      body += chunk;

      if (Buffer.byteLength(body) > 16_384)
        throw new ChatToolError("Callback URL is too large.");
    }

    const fields = new URLSearchParams(body);
    const login = await logins.get(key)?.ready;
    const cookie = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);

    if (
      !login ||
      login.failure ||
      login.serverUrl !== integration.url ||
      fields.get("session") !== login.id ||
      cookie !== login.id
    )
      throw new ChatToolError(
        "Sign-in expired or invalid. Open sign-in again.",
      );

    const callback = new URL(fields.get("callback") ?? "");
    const authorization = new URL(login.url);
    const redirect = new URL(authorization.searchParams.get("redirect_uri")!);

    if (
      callback.origin !== redirect.origin ||
      callback.pathname !== redirect.pathname ||
      callback.searchParams.get("state") !==
        authorization.searchParams.get("state")
    )
      throw new ChatToolError(
        "Paste the complete callback URL from this sign-in attempt.",
      );

    login.callback(callback.href);
    await login.done;
    logins.delete(key);
    response.setHeader(
      "Set-Cookie",
      `${cookieName}=; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    response.end(
      "Connected. Return to Paws and ask the agent to verify access.",
    );
  } catch (error) {
    response
      .writeHead(400)
      .end(
        escape(
          error instanceof ChatToolError
            ? error.message
            : "Sign-in could not complete. Check the callback URL and try again.",
        ),
      );
  }

  return true;
}
