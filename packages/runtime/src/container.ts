import { assertAgentId } from "@paws/shared";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { realpath, access } from "node:fs/promises";
import { constants, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join, isAbsolute, dirname, basename } from "node:path";
import { provisionWorkspace, type RuntimeLease } from "./index.ts";

const exec = promisify(execFile);
export const runtimeImage = "paws-chat-runtime:1";

// User-supplied secrets only: stdin avoids argv/env logs; /tmp is container tmpfs.
export async function writeRuntimeSecret(
  container: string,
  reference: string,
  value: string,
) {
  if (!/^[a-f0-9-]{36}$/.test(reference))
    throw new Error("Invalid secret reference.");

  const path = `/tmp/paws-secrets/${reference}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
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

export function runtimeIdentity(root: string) {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const directory = join(root, "runtime");
  const path = join(directory, `passwd-${uid}-${gid}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `root:x:0:0:root:/root:/bin/sh\n${uid === 0 ? "" : `agent:x:${uid}:${gid}:Paws agent:/home/agent:/bin/sh\n`}`,
    { mode: 0o600 },
  );

  return path;
}

export function containerArgs(input: {
  name: string;
  workspace: string;
  home: string;
  identity?: string;
  teamIds?: readonly string[];
  root?: string;
  binary?: string;
  entrypoint?: string[];
  helpers?: string[];
  uid: number;
  gid: number;
}) {
  return [
    "run",
    "--rm",
    "--interactive",
    "--name",
    input.name,
    "--label",
    "app=paws",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=1g",
    "--cpus=2",
    "--user",
    `${input.uid}:${input.gid}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
    "--mount",
    `type=bind,src=${input.workspace},dst=/workspace`,
    "--mount",
    `type=bind,src=${input.home},dst=/home/agent`,
    ...(input.identity
      ? ["--mount", `type=bind,src=${input.identity},dst=/etc/passwd,readonly`]
      : []),
    ...(input.teamIds ?? []).flatMap((id) => {
      assertAgentId(id);

      if (!input.root) throw new Error("Team mounts require a data root.");

      return ["skills", "files"].flatMap((folder) => [
        "--mount",
        `type=bind,src=${join(input.root!, "teams", id, folder)},dst=/teams/${id}/${folder}${folder === "skills" ? ",readonly" : ""}`,
      ]);
    }),
    ...(input.binary
      ? [
          "--mount",
          `type=bind,src=${input.binary},dst=/usr/local/bin/codex,readonly`,
        ]
      : []),
    ...(input.helpers ?? []).flatMap((path) => [
      "--mount",
      `type=bind,src=${path},dst=/usr/local/bin/${basename(path)},readonly`,
    ]),
    "--workdir",
    "/workspace",
    "--env",
    "HOME=/home/agent",
    "--env",
    "CODEX_HOME=/home/agent/.codex",
    runtimeImage,
    ...(input.entrypoint ?? ["codex", "app-server", "--listen", "stdio://"]),
  ];
}

export async function leaseCodexRuntime(
  root: string,
  agentId: string,
  binaryPath: string,
  teamIds: readonly string[] = [],
): Promise<
  RuntimeLease & {
    command: string;
    args: string[];
    deliverSecret(reference: string, value: string): Promise<string>;
  }
> {
  const layout = await provisionWorkspace(root, agentId);
  const binary = await resolveExecutable(binaryPath || "codex");

  try {
    await exec("docker", ["image", "inspect", runtimeImage], {
      timeout: 10_000,
    });
  } catch {
    throw new Error(
      "Chat runtime unavailable. Run pnpm runtime:build with Docker running.",
    );
  }

  const helpers: string[] = [];

  for (const helper of ["codex-code-mode-host", "codex-exec-server"]) {
    const path = join(dirname(binary), helper);

    try {
      await access(path, constants.X_OK);
      helpers.push(path);
    } catch {
      // Older Codex distributions embed their helpers in the main executable.
    }
  }

  const name = `paws-chat-${agentId}-${randomUUID().slice(0, 8)}`;

  return {
    agentId,
    isolation: "container",
    workspace: "/workspace",
    home: "/home/agent",
    browserProfile: "/home/agent/browser",
    shell: "/bin/sh",
    tools: ["paws_send_message"],
    command: "docker",
    deliverSecret: (reference, value) =>
      writeRuntimeSecret(name, reference, value),
    args: containerArgs({
      name,
      identity: runtimeIdentity(root),
      workspace: layout.workspace,
      home: layout.home,
      root,
      teamIds,
      binary,
      helpers,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }),
    async dispose() {
      // --rm handles normal exit; force-remove also handles lost docker attach clients.
      await exec("docker", ["rm", "--force", name], { timeout: 10_000 }).catch(
        () => {},
      );
    },
  };
}

// The provider SDK stays on the host with its credentials, but has no native tools.
// Its only execution capability is this container-backed tool lease.
export async function leaseToolRuntime(
  root: string,
  agentId: string,
  teamIds: readonly string[] = [],
) {
  const layout = await provisionWorkspace(root, agentId);
  const name = `paws-tools-${agentId}-${randomUUID().slice(0, 8)}`;
  const args = containerArgs({
    name,
    identity: runtimeIdentity(root),
    workspace: layout.workspace,
    home: layout.home,
    root,
    teamIds,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    entrypoint: ["sleep", "infinity"],
  });
  args.splice(1, 0, "--detach");
  const dispose = async () => {
    await exec("docker", ["rm", "--force", name], { timeout: 10_000 }).catch(
      () => {},
    );
  };

  try {
    await exec("docker", args, { timeout: 30_000 });
  } catch {
    await dispose();

    throw new Error(
      "Chat runtime unavailable. Run pnpm runtime:build with Docker running.",
    );
  }

  return {
    agentId,
    isolation: "container" as const,
    workspace: "/workspace",
    home: "/home/agent",
    browserProfile: "/home/agent/browser",
    shell: "/bin/sh",
    tools: ["paws_exec", "paws_send_message", "request_secret"],
    deliverSecret: (reference: string, value: string) =>
      writeRuntimeSecret(name, reference, value),
    async execute(command: string, signal: AbortSignal) {
      const taskPath = `/tmp/paws-processes/${randomUUID()}`;

      try {
        const result = await exec(
          "docker",
          [
            "exec",
            name,
            "setsid",
            "/bin/sh",
            "-c",
            'mkdir -p /tmp/paws-processes; echo $$ > "$1"; exec /bin/sh -lc "$2"',
            "paws-task",
            taskPath,
            command,
          ],
          {
            signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
            maxBuffer: 256 * 1024,
          },
        );

        return result.stdout + result.stderr;
      } finally {
        // Killing docker exec alone leaves its container process running.
        await exec(
          "docker",
          [
            "exec",
            name,
            "/bin/sh",
            "-c",
            'if [ -f "$1" ]; then pid=$(cat "$1"); kill -KILL -"$pid" 2>/dev/null || true; rm -f "$1"; fi',
            "paws-cleanup",
            taskPath,
          ],
          { timeout: 10_000 },
        ).catch(() => {});
      }
    },
    dispose,
  } satisfies RuntimeLease & Record<string, unknown>;
}
