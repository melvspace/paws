import { spawn } from "node:child_process";
import { realpath, access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, isAbsolute } from "node:path";

// User-supplied secrets only: stdin avoids argv/env logs; /tmp is container tmpfs.
export async function writeRuntimeSecret(
  container: string,
  reference: string,
  value: string,
  user?: string,
) {
  if (!/^[a-f0-9-]{36}$/.test(reference))
    throw new Error("Invalid secret reference.");

  const path = `/tmp/paws-secrets/${reference}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        ...(user ? ["--user", user] : []),
        "--interactive",
        container,
        "/bin/sh",
        "-c",
        'set -euC; umask 077; mkdir -p /tmp/paws-secrets; cat > "$1"',
        "paws-secret",
        path,
      ],
      { stdio: ["pipe", "ignore", "ignore"], timeout: 10000 },
    );
    const fail = () =>
      reject(new Error("Could not deliver the secret to the agent runtime."));
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", (code) => (code === 0 ? resolve() : fail()));
    child.stdin.end(value);
  });

  return path;
}

export async function resolveExecutable(command: string) {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .map((dir) => join(dir, command));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);

      return await realpath(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }

  throw new Error("Codex executable not found.");
}
