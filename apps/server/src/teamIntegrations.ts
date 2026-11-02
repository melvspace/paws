import type { TeamMcpHarness } from "./teamMcpHarness.ts";
import { ChatToolError } from "@paws/provider-core";
import { randomUUID } from "node:crypto";
import * as Fs from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { Team, TeamToolRequest, type TeamIntegration } from "@paws/contracts";
import { assertAgentId } from "@paws/shared";
import { localTeamMcp } from "./localTeamMcp.ts";
import { remoteTeamMcp } from "./teamMcp.ts";
import { agentContext } from "./teamContext.ts";
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

const SecretValues = Schema.Record(Schema.String, Schema.String);
const StoredSecrets = Schema.Struct({
  values: SecretValues,
  endpoint: Schema.NullOr(Schema.String),
});

function readSecrets(path: string) {
  if (!Fs.existsSync(path)) return { values: {}, endpoint: null };

  const data: unknown = JSON.parse(Fs.readFileSync(path, "utf8"));

  if (Schema.is(StoredSecrets)(data)) return data;

  // Legacy HTTP credentials have no endpoint binding and require reconfiguration.
  return {
    values: Schema.decodeUnknownSync(SecretValues)(data),
    endpoint: null,
  };
}

function secretEndpoint(integration: TeamIntegration | undefined) {
  return integration?.kind === "mcp-http"
    ? new URL(integration.url!).href
    : null;
}

export function saveIntegrationSecrets(
  root: string,
  teamId: string,
  integrationId: string,
  values: Record<string, string>,
  configuredIntegration?: TeamIntegration,
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
  const db = new DatabaseSync(join(root, "state.sqlite"), { readOnly: true });
  let integration = configuredIntegration;

  try {
    const row = db.prepare("SELECT data FROM teams WHERE id = ?").get(teamId);

    if (!integration && row) {
      integration = Schema.decodeUnknownSync(Team)(
        JSON.parse(String(row.data)),
      ).integrations?.find((item) => item.id === integrationId);
    }
  } finally {
    db.close();
  }

  const endpoint = secretEndpoint(integration);
  const stored = readSecrets(path);
  const existing = stored.endpoint === endpoint ? stored.values : {};
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    Fs.writeFileSync(
      temporary,
      JSON.stringify({ values: { ...existing, ...values }, endpoint }),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    Fs.renameSync(temporary, path);
  } finally {
    Fs.rmSync(temporary, { force: true });
  }
}

// Remote authentication stays under server control. Local MCP commands execute
// alongside ordinary shell commands in the team environment.
export async function teamTool(
  root: string,
  agentId: string,
  value: unknown,
  signal: AbortSignal,
  consumeSecret?: (reference: string) => string,
  harness?: TeamMcpHarness,
) {
  const input = Schema.decodeUnknownSync(TeamToolRequest)(value);
  assertAgentId(input.teamId);
  const team = agentContext(root, agentId).teams.find(
    (item) => item.id === input.teamId,
  );

  if (!team) throw new Error("Join this team before using its integrations.");
  if (input.action === "list") return team.integrations ?? [];
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
      saveIntegrationSecrets(
        root,
        team.id,
        input.integration.id,
        secretValues,
        input.integration,
      );
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
  const stored = readSecrets(environmentFile);
  const secrets =
    stored.endpoint === secretEndpoint(integration) ? stored.values : {};
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

  if (integration.kind === "mcp-http") {
    if (input.action !== "tools" && (input.action !== "call" || !input.tool))
      throw new ChatToolError(
        "Use tools or call with a tool name for remote MCP integrations.",
      );

    return remoteTeamMcp(
      root,
      team.id,
      integration,
      input,
      secrets,
      signal,
      harness,
    );
  }

  return redact(
    await localTeamMcp(
      root,
      agentId,
      team,
      integration,
      input,
      secrets,
      signal,
    ),
  );
}
