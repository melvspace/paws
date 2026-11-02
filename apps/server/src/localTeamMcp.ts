import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import * as Fs from "node:fs";
import type { Team, TeamIntegration, TeamToolRequest } from "@paws/contracts";
import { ChatToolError } from "@paws/provider-core";
import { leaseToolRuntime } from "@paws/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { withMcpLock } from "./teamMcpAuth.ts";

const exec = promisify(execFile);

export function localTeamMcp(
  root: string,
  agentId: string,
  team: Team,
  integration: TeamIntegration,
  input: TeamToolRequest,
  secrets: Record<string, string>,
  signal: AbortSignal,
) {
  const directory = join(root, "team-auth", team.id, integration.id);

  // A shared file-backed login must not be concurrently imported or updated.
  return withMcpLock(directory, async () => {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    timeout.throwIfAborted();
    const lease = await leaseToolRuntime(root, agentId, {
      teamId: team.id,
      template: team.template,
    });
    const home = `/opt/paws/integrations/${integration.id}/home`;

    try {
      await prepareContext(lease.container!, directory, home, timeout);
      const launch = lease.launch(
        "/usr/bin/timeout",
        [
          "--kill-after=5",
          "180",
          integration.command!,
          ...(integration.args ?? []),
        ],
        { workspace: "/team/files", home },
      );
      const args = launch.args;
      args.splice(
        args.indexOf(lease.container!),
        0,
        ...Object.keys(secrets).flatMap((name) => ["--env", name]),
      );
      const transport = new StdioClientTransport({
        command: launch.command,
        args,
        env: { PATH: process.env.PATH ?? "", ...secrets },
        stderr: "ignore",
      });
      const client = new Client({ name: "paws", version: "0.1.0" });
      const abort = () => {
        void client.close().catch(() => {});
      };
      timeout.addEventListener("abort", abort, { once: true });

      try {
        timeout.throwIfAborted();
        await client.connect(transport);

        if (input.action === "tools")
          return await client.listTools({}, { signal: timeout });
        if (input.action !== "call" || !input.tool)
          throw new Error("Choose a tool returned by tools.");

        return await client.callTool(
          { name: input.tool, arguments: input.arguments ?? {} },
          undefined,
          { signal: timeout },
        );
      } finally {
        timeout.removeEventListener("abort", abort);
        await client.close();
      }
    } catch {
      throw new ChatToolError(
        "MCP operation failed. Check the connection and team environment.",
      );
    } finally {
      await lease.dispose();
    }
  });
}

async function prepareContext(
  container: string,
  directory: string,
  home: string,
  signal: AbortSignal,
) {
  const run = (args: string[]) => exec("docker", args, { signal });
  // The compatibility alias is container-local; ordinary agent cwd/home remain
  // personal. Refuse to replace an existing nonempty directory or another link.
  await withMcpLock(container, () =>
    run([
      "exec",
      container,
      "/bin/sh",
      "-ec",
      'if [ "$(readlink /workspace || true)" != /team/files ]; then if [ -d /workspace ] && [ ! -L /workspace ]; then rmdir /workspace; fi; ln -s /team/files /workspace; fi; mkdir -p /team/files',
    ]),
  );

  try {
    await run(["exec", container, "test", "-d", home]);

    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === 1))
      throw error;
  }

  const legacy = join(directory, "home");

  if (!Fs.lstatSync(legacy).isDirectory())
    throw new Error("Invalid integration authentication home.");

  const temporary = `/tmp/paws-integration-${randomUUID()}`;

  try {
    await run(["exec", container, "mkdir", "--", temporary]);
    // Copy only this integration's dedicated legacy home, never provider state.
    // Docker preserves nested links rather than following them on the host.
    await run(["cp", `${legacy}/.`, `${container}:${temporary}`]);
    await run([
      "exec",
      container,
      "/bin/sh",
      "-ec",
      'chown -R "$3" "$1"; chmod 700 "$1"; mkdir -p "$(dirname "$2")"; mv -T "$1" "$2"',
      "paws-integration",
      temporary,
      home,
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    ]);
  } finally {
    await exec("docker", ["exec", container, "rm", "-rf", "--", temporary], {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
}
