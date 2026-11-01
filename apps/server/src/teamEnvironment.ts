import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as Fs from "node:fs";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { assertAgentId } from "@paws/shared";

const exec = promisify(execFile);
export const teamRuntimeImage = "paws-team-runtime:1";
const installations = new Map<string, Promise<unknown>>();

export function teamEnvironmentImage(root: string, teamId: string) {
  assertAgentId(teamId);
  const path = join(root, "teams", teamId, "environment.json");

  if (!Fs.existsSync(path)) return teamRuntimeImage;

  const image = Schema.decodeUnknownSync(
    Schema.Struct({ image: Schema.String }),
  )(JSON.parse(Fs.readFileSync(path, "utf8"))).image;

  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Invalid team environment image.");

  return image;
}

// Stream package-manager output to a shared log, retaining only a tail in memory.
// Large downloads/build logs must not kill an otherwise successful installation.
async function runInstaller(
  args: string[],
  logPath: string,
  signal: AbortSignal,
) {
  const descriptor = Fs.openSync(logPath, "wx", 0o600);
  let stdout = "";
  let stderr = "";
  let truncated = false;

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      let failure: Error | undefined;
      const child = spawn("docker", args, {
        env: { PATH: process.env.PATH },
        signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const capture = (chunk: Buffer, error: boolean) => {
        if (failure) return;

        try {
          Fs.writeSync(descriptor, chunk);
        } catch (error) {
          failure =
            error instanceof Error
              ? error
              : new Error("Cannot write install log.");
          child.kill();

          return;
        }

        const text = (error ? stderr : stdout) + chunk.toString("utf8");
        truncated ||= text.length > 16000;

        if (error) stderr = text.slice(-16000);
        else stdout = text.slice(-16000);
      };
      child.stdout.on("data", (chunk: Buffer) => capture(chunk, false));
      child.stderr.on("data", (chunk: Buffer) => capture(chunk, true));
      child.on("error", (error) => {
        failure = error;
      });
      child.on("close", (code) => {
        if (failure) reject(failure);
        else resolve(code ?? 1);
      });
    });

    return { exitCode, stdout, stderr, truncated };
  } finally {
    Fs.closeSync(descriptor);
  }
}

// Only successful installations publish a new image. Integration homes/secrets
// are never mounted here, so they cannot enter a committed filesystem layer.
export async function installTeamEnvironment(
  root: string,
  teamId: string,
  script: string,
  signal: AbortSignal,
) {
  assertAgentId(teamId);

  if (!script.trim() || script.length > 64000 || script.includes("\0"))
    throw new Error(
      "Provide an installation script of up to 64,000 characters.",
    );

  const directory = join(root, "teams", teamId);
  const key = resolve(directory);
  const previous = installations.get(key);
  const operation = (async () => {
    await previous?.catch(() => {});
    signal.throwIfAborted();
    const name = `paws-install-${randomUUID()}`;
    const files = join(directory, "files");
    Fs.mkdirSync(files, { recursive: true, mode: 0o700 });
    const log = `.paws-install-${randomUUID()}.log`;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(900000)]);

    try {
      const result = await runInstaller(
        [
          "run",
          "--name",
          name,
          "--label",
          "app=paws",
          "--cap-drop=ALL",
          ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"].flatMap(
            (capability) => ["--cap-add", capability],
          ),
          "--security-opt=no-new-privileges",
          "--pids-limit=512",
          "--memory=2g",
          "--cpus=2",
          "--user=0:0",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
          "--mount",
          `type=bind,src=${files},dst=/workspace,readonly`,
          "--workdir=/opt/paws",
          "--env=HOME=/opt/paws",
          "--env=DEBIAN_FRONTEND=noninteractive",
          teamEnvironmentImage(root, teamId),
          "/bin/bash",
          "-euo",
          "pipefail",
          "-c",
          script,
        ],
        join(files, log),
        timeout,
      );

      if (result.exitCode !== 0) {
        return { ...result, isError: true, log: `/workspace/${log}` };
      }

      timeout.throwIfAborted();
      const namespace = createHash("sha256")
        .update(resolve(root))
        .digest("hex")
        .slice(0, 16);
      const committed = await exec(
        "docker",
        ["commit", name, `paws-team-${namespace}-${teamId}:latest`],
        { signal: timeout },
      );
      const image = committed.stdout.trim();

      if (!/^sha256:[a-f0-9]{64}$/.test(image))
        throw new Error("Docker did not return a team environment image.");

      const path = join(directory, "environment.json");
      const temporary = `${path}.${randomUUID()}.tmp`;

      try {
        Fs.writeFileSync(temporary, JSON.stringify({ image }), {
          mode: 0o600,
          flag: "wx",
        });
        Fs.renameSync(temporary, path);
      } finally {
        Fs.rmSync(temporary, { force: true });
      }

      return { ...result, installed: true, log: `/workspace/${log}` };
    } finally {
      await exec("docker", ["rm", "--force", name], { timeout: 10000 }).catch(
        () => {},
      );
    }
  })();
  installations.set(key, operation);

  try {
    return await operation;
  } finally {
    if (installations.get(key) === operation) installations.delete(key);
  }
}
