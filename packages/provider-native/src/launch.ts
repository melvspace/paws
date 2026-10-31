import { homedir } from "node:os";
import { resolve, join } from "node:path";
import type { ProviderConfig } from "@paws/contracts";
import { providerDriver } from "@paws/provider-core";
import type { ProbeLaunch } from "@paws/provider-core/process";

export function providerLaunch(
  config: ProviderConfig,
  cwd: string,
  signal: AbortSignal,
  environment: Record<string, string>,
): ProbeLaunch {
  const driver = providerDriver(config.driver);
  const launch: ProbeLaunch = {
    command: config.binaryPath || driver.command,
    args: config.args,
    cwd,
    signal,
    env: { ...process.env, ...environment },
  };

  if (config.homePath) {
    const home = resolve(
      config.homePath.startsWith("~/")
        ? `${homedir()}/${config.homePath.slice(2)}`
        : config.homePath,
    );
    const variable =
      config.driver === "codex"
        ? "CODEX_HOME"
        : config.driver === "claudeAgent"
          ? "CLAUDE_CONFIG_DIR"
          : config.driver === "pi"
            ? "PI_CODING_AGENT_DIR"
            : "HOME";
    launch.env![variable] = home;
  }

  if (config.driver === "cursor")
    launch.env!.PAWS_CURSOR_AUTH_FILE =
      environment.PAWS_CURSOR_AUTH_FILE || join(cwd, "cursor-auth.json");

  return launch;
}
