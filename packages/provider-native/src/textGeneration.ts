import type { TextGenerationInput } from "@paws/provider-core";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withProcess, type ProbeLaunch } from "@paws/provider-core/process";

export async function generateClaudeText(
  launch: ProbeLaunch,
  input: TextGenerationInput,
) {
  const directory = await mkdtemp(join(tmpdir(), "paws-text-"));

  try {
    return await withProcess(
      {
        ...launch,
        cwd: directory,
        args: [
          ...launch.args,
          "-p",
          "--model",
          input.model,
          "--output-format",
          "text",
          "--tools",
          "",
          "--strict-mcp-config",
          "--disable-slash-commands",
          "--no-session-persistence",
          "--permission-mode",
          "dontAsk",
          "--system-prompt",
          "Generate only the requested JSON. Never use tools.",
        ],
      },
      (child) =>
        new Promise<string>((resolve, reject) => {
          let output = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            output += chunk;

            if (output.length > 16384)
              reject(new Error("Text generation response too large."));
          });
          child.stdin.end(input.prompt);
          child.once("close", (code) => {
            if (code !== 0)
              reject(
                new Error(
                  "Text generation failed. Check the selected provider.",
                ),
              );
            else resolve(output);
          });
        }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
