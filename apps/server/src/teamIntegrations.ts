import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Fs from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { Team, TeamToolRequest, type TeamIntegration } from "@paws/contracts";
import { assertAgentId } from "@paws/shared";
import { containerArgs, runtimeIdentity } from "@paws/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { agentContext } from "./teamContext.ts";
import {
  installTeamEnvironment,
  teamEnvironmentImage,
} from "./teamEnvironment.ts";

const exec = promisify(execFile);
const integrationIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

export function validateIntegrations(integrations: readonly TeamIntegration[]) {
  if (
    integrations.length > 20 ||
    new Set(integrations.map((item) => item.id)).size !== integrations.length
  ) {
    throw new Error("Use up to 20 integrations with unique IDs.");
  }

  for (const integration of integrations) {
    if (!integrationIdPattern.test(integration.id))
      throw new Error("Invalid integration ID.");
    if (
      (integration.args ?? []).length > 100 ||
      (integration.args ?? []).some((arg) => arg.length > 4096)
    )
      throw new Error("Too many or oversized arguments.");

    if (integration.kind === "mcp-http") {
      const url = new URL(integration.url ?? "");

      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Use an HTTP MCP URL without credentials.");
    } else if (
      !integration.command ||
      integration.command.length > 4096 ||
      integration.command.includes("\0")
    ) {
      throw new Error("A runtime command is required.");
    }
  }

  return integrations;
}

export function saveIntegrationSecrets(
  root: string,
  teamId: string,
  integrationId: string,
  values: Record<string, string>,
) {
  assertAgentId(teamId);

  if (!integrationIdPattern.test(integrationId))
    throw new Error("Invalid integration ID.");

  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(name) || !value || value.length > 16000)
      throw new Error("Invalid credential.");
  }

  const directory = join(root, "team-auth", teamId, integrationId);
  Fs.mkdirSync(join(directory, "home"), { recursive: true, mode: 0o700 });
  const path = join(directory, "environment.json");
  const existing = Fs.existsSync(path)
    ? Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
        JSON.parse(Fs.readFileSync(path, "utf8")),
      )
    : {};
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    Fs.writeFileSync(temporary, JSON.stringify({ ...existing, ...values }), {
      mode: 0o600,
      flag: "wx",
    });
    Fs.renameSync(temporary, path);
  } finally {
    Fs.rmSync(temporary, { force: true });
  }
}

// Authentication homes are only mounted in the separate integration process,
// never in an agent's general-purpose shell or workspace.
export async function teamTool(
  root: string,
  agentId: string,
  value: unknown,
  signal: AbortSignal,
  consumeSecret?: (reference: string) => string,
) {
  const input = Schema.decodeUnknownSync(TeamToolRequest)(value);
  assertAgentId(input.teamId);
  const team = agentContext(root, agentId).teams.find(
    (item) => item.id === input.teamId,
  );

  if (!team) throw new Error("Join this team before using its integrations.");
  if (input.action === "list") return team.integrations ?? [];

  if (input.action === "install") {
    if (!input.script) throw new Error("An installation script is required.");

    return installTeamEnvironment(root, team.id, input.script, signal);
  }

  if (input.action === "configure") {
    if (!input.integration)
      throw new Error("Integration configuration is required.");

    const integrations = validateIntegrations([
      ...(team.integrations ?? []).filter(
        (item) => item.id !== input.integration!.id,
      ),
      input.integration,
    ]);
    const secretValues: Record<string, string> = {};

    for (const [name, reference] of Object.entries(input.secrets ?? {})) {
      if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(name) || !consumeSecret)
        throw new Error("Use a private secret request reference.");

      secretValues[name] = consumeSecret(reference);
    }

    if (Object.keys(secretValues).length) {
      saveIntegrationSecrets(root, team.id, input.integration.id, secretValues);
    }

    const db = new DatabaseSync(join(root, "state.sqlite"));

    try {
      // Re-read under a write lock so concurrent agent setup preserves other entries.
      db.exec("BEGIN IMMEDIATE");
      const row = db
        .prepare("SELECT data FROM teams WHERE id = ?")
        .get(team.id);

      if (!row) throw new Error("Team no longer exists.");

      const current = Schema.decodeUnknownSync(Team)(
        JSON.parse(String(row.data)),
      );
      const next = validateIntegrations([
        ...(current.integrations ?? []).filter(
          (item) => item.id !== input.integration!.id,
        ),
        integrations.at(-1)!,
      ]);
      db.prepare("UPDATE teams SET data = ? WHERE id = ?").run(
        JSON.stringify({ ...current, integrations: next }),
        team.id,
      );
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    return { configured: input.integration.id };
  }

  const integration = team.integrations?.find(
    (item) => item.id === input.integrationId,
  );

  if (!integration)
    throw new Error("Integration not found. List team integrations first.");

  validateIntegrations([integration]);
  const directory = join(root, "team-auth", team.id, integration.id);
  Fs.mkdirSync(join(directory, "home"), { recursive: true, mode: 0o700 });
  const environmentFile = join(directory, "environment.json");
  const secrets = Fs.existsSync(environmentFile)
    ? Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
        JSON.parse(Fs.readFileSync(environmentFile, "utf8")),
      )
    : {};
  const redact = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item !== "string") return item;

        let text = item;

        for (const secret of Object.values(secrets)) {
          if (secret) text = text.split(secret).join("[redacted]");
        }

        return text;
      }),
    );
  const name = `paws-integration-${randomUUID()}`;
  const image = teamEnvironmentImage(root, team.id);
  const args = containerArgs({
    name,
    image,
    identity: runtimeIdentity(root),
    workspace: join(root, "teams", team.id, "files"),
    home: join(directory, "home"),
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    entrypoint: [integration.command ?? "true", ...(integration.args ?? [])],
  });
  const imageIndex = args.indexOf(image);
  args.splice(
    imageIndex,
    0,
    ...Object.keys(secrets).flatMap((name) => ["--env", name]),
  );
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(60000)]);

  try {
    if (input.action === "exec") {
      if (integration.kind !== "cli")
        throw new Error("Use MCP tools/call for MCP integrations.");
      if (
        (input.args ?? []).length > 100 ||
        (input.args ?? []).some((arg) => arg.length > 4096)
      )
        throw new Error("Invalid CLI arguments.");

      try {
        const result = await exec("docker", [...args, ...(input.args ?? [])], {
          env: { PATH: process.env.PATH, ...secrets },
          signal: timeout,
          maxBuffer: 256 * 1024,
        });

        return redact({
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "number"
        ) {
          return redact({
            isError: true,
            exitCode: error.code,
            stdout:
              "stdout" in error && typeof error.stdout === "string"
                ? error.stdout
                : "",
            stderr:
              "stderr" in error && typeof error.stderr === "string"
                ? error.stderr
                : "",
          });
        }

        throw error;
      }
    }

    if (integration.kind === "cli")
      throw new Error("Use exec for CLI integrations.");

    const transport =
      integration.kind === "mcp-http"
        ? new StreamableHTTPClientTransport(new URL(integration.url!), {
            requestInit: {
              headers: secrets.BEARER_TOKEN
                ? { Authorization: `Bearer ${secrets.BEARER_TOKEN}` }
                : {},
              signal: timeout,
            },
          })
        : new StdioClientTransport({
            command: "docker",
            args,
            env: { PATH: process.env.PATH ?? "", ...secrets },
            stderr: "ignore",
          });
    const client = new Client({ name: "paws", version: "0.1.0" });
    const abort = () => {
      void client.close();
    };
    timeout.addEventListener("abort", abort, { once: true });

    try {
      timeout.throwIfAborted();
      await client.connect(transport);

      if (input.action === "tools")
        return redact(await client.listTools({}, { signal: timeout }));
      if (input.action !== "call" || !input.tool)
        throw new Error("Choose a tool returned by tools.");

      return redact(
        await client.callTool(
          { name: input.tool, arguments: input.arguments ?? {} },
          undefined,
          { signal: timeout },
        ),
      );
    } finally {
      timeout.removeEventListener("abort", abort);
      await client.close();
    }
  } catch {
    throw new Error(
      "Team integration failed. Check its configuration, authentication, and runtime availability.",
    );
  } finally {
    if (integration.kind !== "mcp-http") {
      await exec("docker", ["rm", "--force", name], { timeout: 10000 }).catch(
        () => {},
      );
    }
  }
}
