import { ContainerRuntimeError } from "./errors.ts";
export { ContainerRuntimeError } from "./errors.ts";
import { createHash } from "node:crypto";
import { prepareLinuxSandbox, linuxDaemonEnvironment } from "./linuxSetup.ts";
import { fileURLToPath } from "node:url";
import { wslArguments, wslDistribution, wslPath } from "./wsl.ts";
import { execFile, spawn, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
const engines = new Map<string, Promise<ContainerEngine>>();

const installEngine = `for source in "$1"/*; do
  target="/usr/local/bin/$(basename "$source")"
  if ! cmp -s "$source" "$target"; then
    cp "$source" "$target.paws-new"
    chmod 755 "$target.paws-new"
    mv -f "$target.paws-new" "$target"
  fi
done`;

export interface ContainerEngine {
  readonly user?: string;
  launch(args: string[]): { command: string; args: string[] };
  execute(
    args: string[],
    options?: ExecFileOptions,
  ): Promise<{ stdout: string; stderr: string }>;
}

export function containerEngine(
  command = "docker",
  prefix: string[] = [],
): ContainerEngine {
  return {
    launch: (args) => ({ command, args: [...prefix, ...args] }),
    async execute(args, options = {}) {
      try {
        const result = await exec(command, [...prefix, ...args], {
          windowsHide: true,
          ...options,
          encoding: "utf8",
        });

        return { stdout: String(result.stdout), stderr: String(result.stderr) };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          throw new ContainerRuntimeError(
            "Paws runtime has not been prepared. Restart Paws to finish setup.",
            { cause: error },
          );

        throw error;
      }
    },
  };
}

export function getContainerEngine(root: string) {
  const key = resolve(root);
  const existing = engines.get(key);

  if (existing) return existing;

  const pending = prepareEngine(key)
    .catch((error: unknown) => {
      if (error instanceof ContainerRuntimeError) throw error;

      throw new ContainerRuntimeError(
        "Paws could not prepare containers. Check internet access and OS virtualization support, then retry.",
        { cause: error },
      );
    })
    .finally(() => {
      engines.delete(key);
    });
  engines.set(key, pending);

  return pending;
}

async function prepareEngine(root: string) {
  const assets = process.env.PAWS_RUNTIME_ASSETS;

  // Development and server deployments retain their configured Docker engine.
  if (!assets) return containerEngine();

  const directory = join(root, "runtime");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const selection = join(directory, "engine");
  let backend: string;

  try {
    backend = await readFile(selection, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;

    // Never silently move existing writable containers into an empty engine.
    const environments = await readdir(join(directory, "environments")).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];

        throw error;
      },
    );
    backend = environments.length ? "docker" : "managed";
    await writeFile(selection, backend, { mode: 0o600, flag: "wx" });
  }

  if (backend === "docker") return containerEngine();
  if (backend !== "managed") throw new Error("Invalid Paws runtime selection.");

  const engine = await startManagedEngine(root, assets);

  await prepareRuntimeImage(engine, join(assets, "image"));

  return engine;
}

export async function prepareRuntimeImage(
  engine: ContainerEngine,
  context = fileURLToPath(new URL("../docker/", import.meta.url)),
) {
  try {
    await engine.execute(["image", "inspect", "paws-team-runtime:1"], {
      timeout: 30_000,
    });
  } catch (error) {
    if (!missingImage(error)) throw error;

    await engine.execute(
      [
        "build",
        "--file",
        join(context, "Dockerfile.team"),
        "--tag",
        "paws-team-runtime:1",
        context,
      ],
      { timeout: 900_000, maxBuffer: 8 * 1024 * 1024 },
    );
  }
}

function missingImage(error: unknown) {
  return (
    error instanceof Error &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    /No such image|No such object/i.test(error.stderr)
  );
}

async function startManagedEngine(root: string, assets: string) {
  const directory = join(root, "runtime");
  const client = join(directory, "client");
  await mkdir(client, { recursive: true, mode: 0o700 });
  await writeFile(
    join(client, "config.json"),
    JSON.stringify({
      cliPluginsExtraDirs: [join(assets, "plugins")],
    }),
    { mode: 0o600 },
  );

  if (process.platform === "darwin") {
    const limaHome = join(directory, "lima");
    const lima = join(assets, "lima", "bin", "limactl");
    const env = { ...process.env, LIMA_HOME: limaHome };
    await mkdir(limaHome, { recursive: true, mode: 0o700 });
    const configuration = join(directory, "machine.yaml");
    // Override the template's home mount: administrative state and credentials
    // must never be shared with the VM, even read-only.
    const config = {
      base: ["template:_images/ubuntu-lts"],
      containerd: { system: false, user: false },
      vmType: "vz",
      mountType: "virtiofs",
      cpus: 4,
      memory: "6GiB",
      mounts: [
        { location: join(root, "teams"), writable: true },
        { location: join(root, "standalone"), writable: true },
        {
          location: join(assets, "docker-linux"),
          mountPoint: "/mnt/paws-engine",
          writable: false,
        },
      ],
      provision: [
        {
          mode: "system",
          script: `#!/bin/sh
set -eu
set -- /mnt/paws-engine
${installEngine}
command -v iptables >/dev/null || (apt-get update && apt-get install -y iptables)
cat > /etc/systemd/system/paws-engine.service <<'PAWS_SERVICE'
[Unit]
After=network-online.target
[Service]
ExecStart=/usr/local/bin/dockerd --group {{.User}} -H unix:///run/docker.sock
Restart=on-failure
[Install]
WantedBy=multi-user.target
PAWS_SERVICE
systemctl daemon-reload
systemctl enable --now paws-engine.service
`,
        },
      ],
      probes: [
        {
          script:
            "#!/bin/sh\nset -eu\nfor attempt in $(seq 1 60); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done\nexit 1\n",
        },
      ],
      portForwards: [
        {
          guestSocket: "/run/docker.sock",
          hostSocket: "{{.Dir}}/sock/docker.sock",
        },
      ],
    };
    await Promise.all(
      config.mounts.map((mount) =>
        mkdir(mount.location, { recursive: true, mode: 0o700 }),
      ),
    );
    await writeFile(configuration, JSON.stringify(config), { mode: 0o600 });
    const instances = await readdir(limaHome);
    const start = instances.includes("paws")
      ? ["start", "--tty=false", "paws"]
      : ["start", "--name=paws", "--tty=false", configuration];
    await exec(lima, start, {
      env,
      timeout: 900_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    return containerEngine(join(assets, "docker", "docker"), [
      "--host",
      `unix://${join(limaHome, "paws", "sock", "docker.sock")}`,
      "--config",
      client,
    ]);
  }

  if (process.platform === "win32") {
    const distribution = wslDistribution(root);
    let installed: string;

    try {
      const result = await exec("wsl.exe", ["--list", "--quiet"], {
        encoding: "utf16le",
        timeout: 30_000,
        windowsHide: true,
      });
      installed = result.stdout;
    } catch {
      throw new ContainerRuntimeError(
        "Paws needs WSL2. Enable Windows Subsystem for Linux and virtualization, restart Windows if requested, then retry.",
      );
    }

    if (
      !installed.split(/\r?\n/).some((name) => name.trim() === distribution)
    ) {
      await exec(
        "wsl.exe",
        [
          "--import",
          distribution,
          join(directory, "wsl"),
          join(assets, "ubuntu.wsl"),
          "--version",
          "2",
        ],
        { timeout: 900_000, windowsHide: true },
      );
    }

    const prefix = ["--distribution", distribution, "--user", "root", "--exec"];
    await exec(
      "wsl.exe",
      [
        ...prefix,
        "/bin/sh",
        "-ec",
        `
set -eu
${installEngine}
mkdir -p /root/.docker
printf '%s\\n' '{"cliPluginsExtraDirs":["/usr/local/bin"]}' > /root/.docker/config.json
command -v iptables >/dev/null || (apt-get update && apt-get install -y iptables)
if ! docker info >/dev/null 2>&1; then
  nohup dockerd --host unix:///var/run/docker.sock >/var/log/paws-engine.log 2>&1 </dev/null &
fi
for attempt in $(seq 1 60); do
  docker info >/dev/null 2>&1 && exit 0
  sleep 1
done
exit 1
`,
        "paws-engine",
        wslPath(join(assets, "docker-linux")),
      ],
      {
        timeout: 900_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const bridge = containerEngine(process.execPath, [
      fileURLToPath(new URL("./wslBridge.ts", import.meta.url)),
      distribution,
    ]);

    return {
      user: "0:0",
      launch: (args) => bridge.launch(wslArguments(args)),
      execute: (args, options) => bridge.execute(wslArguments(args), options),
    } satisfies ContainerEngine;
  }

  if (process.platform !== "linux")
    throw new Error(
      "The managed runtime is not available on this platform yet.",
    );

  let bin = join(assets, "docker");
  const socket = join(directory, "docker.sock");
  const engine = {
    ...containerEngine(join(bin, "docker"), [
      "--host",
      `unix://${socket}`,
      "--config",
      client,
    ]),
    user: "0:0",
  };

  try {
    await engine.execute(["info"], { timeout: 10_000 });

    return engine;
  } catch {
    // Only start our own daemon; never stop or reconfigure a system engine.
  }

  // AppImage mounts disappear when Paws closes. Keep daemon executables and
  // their AppArmor attachment path independent of that temporary mount.
  const version = createHash("sha256")
    .update(await readFile(join(bin, "rootlesskit")))
    .update(await readFile(join(bin, "dockerd")))
    .update(await readFile(join(assets, "setup", "paws-runtime-setup")))
    .digest("hex")
    .slice(0, 16);
  const installation = join(directory, "installation", version);

  try {
    await access(join(installation, "complete"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;

    await mkdir(installation, { recursive: true, mode: 0o700 });
    await cp(bin, join(installation, "docker"), { recursive: true });
    await cp(join(assets, "setup"), join(installation, "setup"), {
      recursive: true,
    });
    await writeFile(join(installation, "complete"), "", { mode: 0o600 });
  }

  bin = join(installation, "docker");
  await prepareLinuxSandbox(installation);

  const run = join(directory, "run");
  await mkdir(run, { recursive: true, mode: 0o700 });
  const configuration = join(directory, "daemon.json");
  await writeFile(configuration, "{}", { mode: 0o600 });
  const log = await open(join(directory, "engine.log"), "a", 0o600);
  const child = spawn(
    join(bin, "dockerd-rootless.sh"),
    [
      "--config-file",
      configuration,
      "--host",
      `unix://${socket}`,
      "--data-root",
      join(directory, "data"),
      "--exec-root",
      join(run, "docker"),
      "--pidfile",
      join(run, "docker.pid"),
    ],
    {
      env: linuxDaemonEnvironment(bin, run),
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  let failure: Error | undefined;
  child.once("error", (error) => {
    failure = error;
  });
  child.once("exit", (code) => {
    failure ??= new ContainerRuntimeError(
      `Paws container engine exited (${code}). Check ${join(directory, "engine.log")}.`,
    );
  });
  child.unref();
  await log.close();

  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (failure) throw failure;

      try {
        await access(socket);
        await engine.execute(["info"], { timeout: 5_000 });

        return engine;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    throw new ContainerRuntimeError(
      `Paws container engine did not become ready. Check ${join(directory, "engine.log")}.`,
    );
  } catch (error) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }

    throw error;
  }
}
