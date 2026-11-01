import { randomUUID } from "node:crypto";
import * as Fs from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import type { ProviderConfig, TeamIntegration } from "@paws/contracts";
import { ChatToolError, type McpHarnessClient } from "@paws/provider-core";
import { callCodexMcp, authenticateCodexMcp } from "@paws/provider-codex";
import { leaseCodexRuntime, workspaceLayout } from "@paws/runtime";

export interface TeamMcpHarness {
  providerId: string;
  client(
    teamId: string,
    integration: TeamIntegration,
    secrets: Record<string, string>,
  ): McpHarnessClient;
}

export function teamMcpHarness(
  root: string,
  config: ProviderConfig,
): TeamMcpHarness | undefined {
  if (config.driver !== "codex") return undefined;

  return {
    providerId: config.id,
    client(teamId, integration, secrets) {
      const privateRoot = join(
        root,
        "team-auth",
        teamId,
        integration.id,
        "codex",
      );
      const home = workspaceLayout(privateRoot, teamId).codexHome;
      const options = [
        ...config.args,
        "-c",
        `mcp_servers.shared.url=${JSON.stringify(integration.url)}`,
        "-c",
        'mcp_oauth_credentials_store="file"',
        "-c",
        "mcp_servers.shared.startup_timeout_sec=60",
        "-c",
        "mcp_servers.shared.tool_timeout_sec=120",
        "-c",
        "features.plugins=false",
      ];
      const run = async <T>(
        args: string[],
        signal: AbortSignal,
        use: (launch: {
          command: string;
          args: string[];
          cwd: string;
          signal: AbortSignal;
          env: NodeJS.ProcessEnv;
        }) => Promise<T>,
      ) => {
        const lease = await leaseCodexRuntime(
          privateRoot,
          teamId,
          config.binaryPath,
        );

        try {
          // Only this isolated helper sees the team's native MCP authentication home.
          await Fs.writeFile(
            join(home, "config.toml"),
            secrets.BEARER_TOKEN
              ? `[mcp_servers.shared.http_headers]\nAuthorization = ${JSON.stringify(`Bearer ${secrets.BEARER_TOKEN}`)}\n`
              : "",
            { mode: 0o600 },
          );
          const result = await use({
            command: lease.command,
            args: [
              ...lease.args.slice(0, lease.args.lastIndexOf("codex")),
              "codex",
              ...options,
              ...args,
            ],
            cwd: root,
            signal,
            env: { PATH: process.env.PATH },
          });

          return await redactNativeResult(home, secrets, result);
        } catch (error) {
          if (error instanceof ChatToolError) throw error;

          throw new ChatToolError(
            "Codex MCP operation failed. Check the harness version, container runtime, and server connection.",
          );
        } finally {
          await lease.dispose();
        }
      };

      return {
        request: (input, signal) =>
          run(["app-server", "--listen", "stdio://"], signal, (launch) =>
            callCodexMcp(launch, input),
          ),
        authenticate: (onUrl, callback, signal) =>
          run(["mcp", "login", "shared", "--no-browser"], signal, (launch) =>
            authenticateCodexMcp(launch, onUrl, callback),
          ),
      };
    },
  };
}

async function redactNativeResult<T>(
  home: string,
  secrets: Record<string, string>,
  result: T,
): Promise<T> {
  if (result === undefined) return result;

  const values = [...Object.values(secrets)];
  const collect = (value: unknown, key = "") => {
    if (typeof value === "string" && /token|secret|verifier/i.test(key))
      values.push(value);
    else if (value && typeof value === "object") {
      for (const [name, child] of Object.entries(value)) collect(child, name);
    }
  };

  try {
    collect(
      JSON.parse(await Fs.readFile(join(home, ".credentials.json"), "utf8")),
    );
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
  }

  return JSON.parse(
    JSON.stringify(result, (_key, item: unknown) => {
      if (typeof item !== "string") return item;

      for (const value of values) {
        if (value) item = String(item).split(value).join("[redacted]");
      }

      return item;
    }),
  );
}

const HarnessBinding = Schema.Struct({
  providerId: Schema.String,
  url: Schema.String,
});

export async function rememberMcpHarness(
  root: string,
  teamId: string,
  integration: TeamIntegration,
  harness: TeamMcpHarness,
) {
  const directory = join(root, "team-auth", teamId, integration.id);
  await Fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `harness-${randomUUID()}.tmp`);

  try {
    await Fs.writeFile(
      temporary,
      JSON.stringify({ providerId: harness.providerId, url: integration.url }),
      { mode: 0o600, flag: "wx" },
    );
    await Fs.rename(temporary, join(directory, "harness.json"));
  } finally {
    await Fs.rm(temporary, { force: true });
  }
}

export async function rememberedMcpHarness(
  root: string,
  teamId: string,
  integration: TeamIntegration,
) {
  try {
    const saved = Schema.decodeUnknownSync(HarnessBinding)(
      JSON.parse(
        await Fs.readFile(
          join(root, "team-auth", teamId, integration.id, "harness.json"),
          "utf8",
        ),
      ),
    );

    return saved.url === integration.url ? saved.providerId : undefined;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;

    throw error;
  }
}
