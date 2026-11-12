import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

import { RuntimeSetupError } from "./errors.ts";

const exec = promisify(execFile);

export async function prepareLinuxSandbox(
  assets: string,
  run: (command: string, args: string[]) => Promise<unknown> = (
    command,
    args,
  ) =>
    exec(command, args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }),
) {
  const binary = join(assets, "docker", "rootlesskit");

  try {
    await run(binary, ["--net=none", "/bin/true"]);
  } catch (error) {
    throw new RuntimeSetupError(
      join(assets, "setup", "paws-runtime-setup"),
      binary,
      error,
    );
  }
}

export function linuxDaemonEnvironment(bin: string, run: string) {
  const session =
    process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;

  return {
    HOME: homedir(),
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    XDG_RUNTIME_DIR: session,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${session}/bus`,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR: join(run, "rootlesskit"),
  };
}
