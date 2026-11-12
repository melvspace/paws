import type { TextGenerationInput } from "@paws/provider-core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
  runCommand,
  withProcess,
  type ProbeLaunch,
} from "@paws/provider-core/process";

const McpServers = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    enabled: Schema.Boolean,
  }),
);

// Separate ephemeral process: no agent workspace, chat session or Paws tools.
export async function generateCodexText(
  launch: ProbeLaunch,
  input: TextGenerationInput,
) {
  const directory = await mkdtemp(join(tmpdir(), "paws-text-"));
  const base = [
    ...launch.args,
    "--config",
    "features.plugins=false",
    "--config",
    "features.apps=false",
  ];

  try {
    const listed = await runCommand({
      ...launch,
      cwd: directory,
      args: [...base, "mcp", "list", "--json"],
    });
    const servers = Schema.decodeUnknownSync(McpServers)(JSON.parse(listed));
    const disabled = servers
      .filter((server) => server.enabled)
      .map((server) => `${JSON.stringify(server.name)}={enabled=false}`);
    const output = join(directory, "result.json");
    const schema = join(directory, "schema.json");
    await writeFile(schema, JSON.stringify(input.schema));
    await withProcess(
      {
        ...launch,
        cwd: directory,
        args: [
          ...base,
          ...(disabled.length
            ? ["--config", `mcp_servers={${disabled.join(",")}}`]
            : []),
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--model",
          input.model,
          "--config",
          'model_reasoning_effort="low"',
          "--config",
          'developer_instructions="Generate only the requested JSON. Never use tools or inspect files."',
          "--output-schema",
          schema,
          "--output-last-message",
          output,
          "-",
        ],
      },
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.stdout.resume();
          child.stdin.end(input.prompt);
          child.once("close", (code) => {
            if (code !== 0)
              reject(
                new Error(
                  "Text generation failed. Check the selected provider.",
                ),
              );
            else resolve();
          });
        }),
    );

    return await readFile(output, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
