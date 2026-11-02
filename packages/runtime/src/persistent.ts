import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import { join, resolve, basename, dirname } from "node:path";
import { assertAgentId } from "@paws/shared";
import {
  executionPaths,
  provisionWorkspace,
  type RuntimeLease,
} from "./index.ts";
import { resolveExecutable, writeRuntimeSecret } from "./container.ts";

const exec = promisify(execFile);
const preparations = new Map<string, Promise<string>>();
const template = "paws-team-runtime:1";

const identity = () =>
  `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;

function executeHost(
  command: string,
  workspace: string,
  home: string,
  signal: AbortSignal,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: workspace,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: `${home}/.codex` },
      detached: true,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let failure: Error | undefined;
    const kill = () => {
      if (!child.pid) return;

      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Process already exited. */
      }
    };
    const capture = (chunk: Buffer) => {
      output += chunk.toString("utf8");

      if (Buffer.byteLength(output) > 256 * 1024) {
        failure = new Error("Command output exceeded the limit.");
        kill();
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      failure = error;
      kill();
    });
    child.on("close", (code) => {
      if (failure || code !== 0) {
        kill();
        reject(failure ?? new Error("Command failed."));
      } else resolve(output);
    });
  });
}

export interface Environment {
  teamId?: string | null;
  sandbox?: boolean;
  template?: string | undefined;
  ephemeral?: boolean;
}

export function environmentName(
  root: string,
  id: string,
  kind: "team" | "agent",
) {
  assertAgentId(id);
  const namespace = createHash("sha256")
    .update(resolve(root))
    .digest("hex")
    .slice(0, 16);

  return `paws-${namespace}-${kind}-${id}`;
}

// A retained container owns its writable OS layer. Releasing an agent lease never
// removes or stops its environment, including background commands and installs.
export async function ensureEnvironment(
  root: string,
  agentId: string,
  environment: Environment,
) {
  const teamId = environment.teamId;
  const name = environmentName(
    root,
    environment.ephemeral ? randomUUID() : (teamId ?? agentId),
    teamId ? "team" : "agent",
  );
  const pending = preparations.get(name);

  if (pending) return pending;

  const preparation = (async () => {
    let exists = true;
    let created = false;

    try {
      try {
        await exec("docker", ["container", "inspect", name], {
          timeout: 10_000,
        });
      } catch (error) {
        // A daemon outage is not evidence that a persisted environment is absent.
        if (
          !error ||
          typeof error !== "object" ||
          !("stderr" in error) ||
          typeof error.stderr !== "string" ||
          !/No such (container|object)/i.test(error.stderr)
        )
          throw error;

        exists = false;
      }

      if (!exists) {
        const source = teamId
          ? join(root, "teams", teamId)
          : join(root, "standalone", agentId);
        await mkdir(source, { recursive: true, mode: 0o700 });
        await exec(
          "docker",
          [
            "create",
            "--name",
            name,
            "--label",
            "app=paws",
            ...(environment.ephemeral
              ? ["--rm", "--restart=no"]
              : ["--restart=unless-stopped"]),
            "--init",
            "--cap-drop=ALL",
            ...[
              "CHOWN",
              "DAC_OVERRIDE",
              "FOWNER",
              "SETUID",
              "SETGID",
              "AUDIT_WRITE",
              "KILL",
            ].flatMap((cap) => ["--cap-add", cap]),
            "--pids-limit=1024",
            "--memory=4g",
            "--cpus=4",
            "--user=0:0",
            "--mount",
            `type=bind,src=${resolve(source)},dst=${teamId ? "/team" : "/agent"}`,
            "--env=DEBIAN_FRONTEND=noninteractive",
            environment.template ?? template,
            "sleep",
            "infinity",
          ],
          { timeout: 120_000 },
        );
        created = true;
      }

      if (!environment.ephemeral) {
        await mkdir(join(root, "runtime", "environments"), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(join(root, "runtime", "environments", name), "", {
          mode: 0o600,
        });
      }

      await exec("docker", ["start", name], { timeout: 30_000 });
      // Older committed team images predate these runtime dependencies. Install
      // missing tools in the retained writable layer before starting a provider.
      await exec(
        "docker",
        [
          "exec",
          "--user=0:0",
          name,
          "/usr/bin/timeout",
          "--kill-after=5",
          "110",
          "/bin/sh",
          "-ec",
          'for tool in sudo setsid ps rg ffmpeg; do if ! command -v "$tool" >/dev/null; then apt-get update; apt-get install -y --no-install-recommends sudo util-linux procps ripgrep ffmpeg; break; fi; done',
        ],
        { signal: AbortSignal.timeout(120_000) },
      );
      // Ordinary files use the server's uid; sudo grants full control inside this
      // environment without making every private home/file host-root-owned.
      await exec(
        "docker",
        [
          "exec",
          "--user=0:0",
          name,
          "/bin/sh",
          "-c",
          'if ! getent group "$2" >/dev/null; then groupadd --gid "$2" paws; fi; if ! getent passwd "$1" >/dev/null; then useradd --no-create-home --uid "$1" --gid "$2" --shell /bin/bash --password "*" paws; fi; mkdir -p /etc/sudoers.d; printf "#%s ALL=(ALL) NOPASSWD: ALL\\n" "$1" > /etc/sudoers.d/paws; chmod 440 /etc/sudoers.d/paws',
          "paws-identity",
          String(process.getuid?.() ?? 1000),
          String(process.getgid?.() ?? 1000),
        ],
        { timeout: 10_000 },
      );

      return name;
    } catch (error) {
      if (environment.ephemeral && created)
        await exec("docker", ["rm", "--force", name], { timeout: 30_000 });

      throw error;
    }
  })();
  preparations.set(name, preparation);

  try {
    return await preparation;
  } finally {
    if (preparations.get(name) === preparation) preparations.delete(name);
  }
}

export async function stopEnvironment(
  root: string,
  id: string,
  kind: "team" | "agent",
) {
  const name = environmentName(root, id, kind);
  await preparations.get(name)?.catch(() => {});

  try {
    await access(join(root, "runtime", "environments", name));
  } catch {
    return;
  }

  try {
    await exec("docker", ["stop", name], { timeout: 30_000 });
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("stderr" in error) ||
      typeof error.stderr !== "string" ||
      !/No such (container|object)/i.test(error.stderr)
    )
      throw error;
  }
}

export async function leaseToolRuntime(
  root: string,
  agentId: string,
  environment: Environment = {},
) {
  const layout = await provisionWorkspace(
    root,
    agentId,
    environment.teamId ?? null,
  );
  const paths = executionPaths(root, agentId, environment);
  const isolated = Boolean(environment.teamId || environment.sandbox);
  const name = isolated
    ? await ensureEnvironment(root, agentId, environment)
    : null;
  const secrets: string[] = [];
  const processes: string[] = [];

  return {
    agentId,
    isolation: isolated ? "container" : "host",
    ...paths,
    shell: "/bin/bash",
    tools: ["paws_exec", "paws_send_message", "request_secret"],
    container: name,
    async deliverSecret(reference: string, value: string) {
      if (!/^[a-f0-9-]{36}$/.test(reference))
        throw new Error("Invalid secret reference.");

      const path = name
        ? await writeRuntimeSecret(name, reference, value, identity())
        : join(layout.base, `.paws-secret-${reference}`);

      if (!name) await writeFile(path, value, { mode: 0o600, flag: "wx" });

      secrets.push(path);

      return path;
    },
    launch(
      command: string,
      args: string[],
      context: { workspace: string; home: string } = paths,
    ) {
      if (!name) return { command, args };

      const marker = `/tmp/paws-runtime-${randomUUID()}`;
      processes.push(marker);

      return {
        command: "docker",
        args: [
          "exec",
          "--user",
          identity(),
          "--interactive",
          "--workdir",
          context.workspace,
          "--env",
          `HOME=${context.home}`,
          "--env",
          `CODEX_HOME=${context.home}/.codex`,
          name,
          "setsid",
          "--wait",
          "/bin/bash",
          "-c",
          'echo $$ > "$1"; shift; exec "$@"',
          "paws-runtime",
          marker,
          command,
          ...args,
        ],
      };
    },
    async execute(command: string, signal: AbortSignal) {
      if (!name)
        return executeHost(command, layout.workspace, paths.home, signal);

      const taskPath = `/tmp/paws-process-${randomUUID()}`;
      let completed = false;

      try {
        const result = await exec(
          "docker",
          [
            "exec",
            "--user",
            identity(),
            "--workdir",
            paths.workspace,
            "--env",
            `HOME=${paths.home}`,
            "--env",
            `CODEX_HOME=${paths.home}/.codex`,
            name,
            "setsid",
            "--wait",
            "/bin/bash",
            "-c",
            'echo $$ > "$1"; exec /bin/bash -lc "$2"',
            "paws-task",
            taskPath,
            command,
          ],
          {
            cwd: layout.workspace,
            env: {
              PATH: process.env.PATH,
              HOME: paths.home,
              CODEX_HOME: `${paths.home}/.codex`,
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
            maxBuffer: 256 * 1024,
          },
        );
        completed = true;

        return result.stdout + result.stderr;
      } finally {
        if (name) {
          // Only cancel this invocation, never another teammate's processes.
          await exec(
            "docker",
            [
              "exec",
              name,
              "/bin/sh",
              "-c",
              'if [ -f "$1" ]; then if [ "$2" != completed ]; then pid=$(cat "$1"); kill -KILL -"$pid" 2>/dev/null || true; fi; rm -f "$1"; fi',
              "paws-cleanup",
              taskPath,
              completed ? "completed" : "failed",
            ],
            { timeout: 10_000 },
          ).catch(() => {});
        }
      }
    },
    async dispose() {
      for (const marker of processes) {
        await exec(
          "docker",
          [
            "exec",
            name!,
            "/bin/sh",
            "-c",
            'if [ -f "$1" ]; then pid=$(cat "$1"); kill -KILL -"$pid" 2>/dev/null || true; rm -f "$1"; fi',
            "paws-cleanup",
            marker,
          ],
          { timeout: 10_000 },
        ).catch(() => {});
      }

      for (const path of secrets) {
        if (name)
          await exec("docker", ["exec", name, "rm", "-f", "--", path], {
            timeout: 10_000,
          }).catch(() => {});
        else await rm(path, { force: true });
      }

      if (name && environment.ephemeral)
        await exec("docker", ["rm", "--force", name], { timeout: 30_000 });
    },
  } satisfies RuntimeLease & Record<string, unknown>;
}

export async function leaseCodexRuntime(
  root: string,
  agentId: string,
  binaryPath: string,
  environment: Environment = {},
) {
  const lease = await leaseToolRuntime(root, agentId, environment);

  try {
    const binary = await resolveExecutable(binaryPath || "codex");
    let executable = binary;

    if (lease.container) {
      // Content addressing avoids replacing a binary another agent is executing.
      const directory = `/opt/paws/harness/${createHash("sha256")
        .update(await readFile(binary))
        .digest("hex")
        .slice(0, 16)}`;
      await exec(
        "docker",
        ["exec", lease.container, "mkdir", "-p", directory],
        {
          timeout: 10_000,
        },
      );

      for (const source of [
        binary,
        ...["codex-code-mode-host", "codex-exec-server"].map((helper) =>
          join(dirname(binary), helper),
        ),
      ]) {
        try {
          await access(source);
        } catch {
          continue;
        }

        const temporary = `${directory}/copy-${randomUUID()}`;
        await exec(
          "docker",
          ["cp", source, `${lease.container}:${temporary}`],
          {
            timeout: 30_000,
          },
        );
        await exec(
          "docker",
          [
            "exec",
            lease.container,
            "mv",
            temporary,
            `${directory}/${basename(source)}`,
          ],
          { timeout: 10_000 },
        );
      }

      executable = `${directory}/${basename(binary)}`;
    }

    return {
      ...lease,
      ...lease.launch(executable, ["app-server", "--listen", "stdio://"]),
    };
  } catch (error) {
    await lease.dispose();

    throw error;
  }
}
