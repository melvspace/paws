import { providerLaunch } from "./launch.ts";
import { Schema } from "effect";
import type {
  ProviderConfig,
  ProviderModel,
  ProviderSnapshot,
} from "@paws/contracts";
import { discoverCodex } from "@paws/provider-codex";
import { runCommand, withJsonRpc } from "@paws/provider-core/process";
import { discoverClaude, discoverCursor, discoverMuse } from "./sdk.ts";
import { discoverOpenCode } from "./opencode.ts";
import { discoverAcp } from "./acp.ts";
import { discoverGrok } from "./grok.ts";
import { piModels, fxModels } from "./catalogs.ts";

export interface ProviderDiscovery {
  auth: ProviderSnapshot["auth"];
  account?: ProviderSnapshot["account"];
  models: readonly ProviderModel[];
  version: string | null;
}

export async function discoverProvider(
  config: ProviderConfig,
  cwd: string,
  signal: AbortSignal,
  environment: Record<string, string> = {},
): Promise<ProviderDiscovery> {
  const launch = providerLaunch(config, cwd, signal, environment);

  if (!launch.command) throw new Error("Set the provider executable first.");

  // Arbitrary ACP agents need not implement --version; initialize is authoritative.
  const versionText =
    config.driver === "acpRegistry" ||
    config.driver === "antigravity" ||
    config.driver === "cursor" ||
    config.driver === "opencode"
      ? ""
      : await runCommand({ ...launch, args: [...launch.args, "--version"] });
  const version =
    /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(versionText)?.[0] ?? null;
  let discovery: Omit<ProviderDiscovery, "version">;

  switch (config.driver) {
    case "codex":
      discovery = await discoverCodex(launch);
      break;
    case "claudeAgent":
      discovery = await discoverClaude(launch);
      break;
    case "cursor":
      discovery = await discoverCursor(launch);
      break;
    case "muse":
      discovery = await discoverMuse(launch);
      break;
    case "opencode":
      return discoverOpenCode(launch);
    case "grok":
      discovery = await discoverGrok(launch);
      break;
    case "fx": {
      const [status, models] = await Promise.all([
        runCommand({ ...launch, args: [...launch.args, "status", "--json"] }),
        runCommand({ ...launch, args: [...launch.args, "models", "--json"] }),
      ]);
      discovery = fxModels(JSON.parse(status), JSON.parse(models));
      break;
    }
    case "pi":
      discovery = await withJsonRpc(
        {
          ...launch,
          args: [
            ...launch.args,
            "--mode",
            "rpc",
            "--no-session",
            "--no-tools",
            "--no-extensions",
          ],
        },
        async (rpc) => {
          const state = Schema.decodeUnknownSync(
            Schema.Struct({ thinkingLevel: Schema.optional(Schema.String) }),
          )(await rpc.request("get_state"));
          const models = piModels(
            await rpc.request("get_available_models"),
            state.thinkingLevel ?? "medium",
          );

          return {
            auth: models.length ? "authenticated" : "unauthenticated",
            models,
          };
        },
        "pi",
      );
      break;
    case "antigravity":
    case "acpRegistry":
      discovery = await discoverAcp(launch);
      break;
  }

  return { ...discovery, version };
}

export { signInProvider } from "./auth.ts";

export { runClaudeTurn } from "./claudeChat.ts";
export { providerLaunch } from "./launch.ts";

export { runCursorTurn } from "./cursorChat.ts";

export { runOpenCodeTurn } from "./opencodeChat.ts";
export { runPiTurn } from "./piChat.ts";

export { runAcpTurn } from "./acpChat.ts";
export { runMuseTurn } from "./museChat.ts";
