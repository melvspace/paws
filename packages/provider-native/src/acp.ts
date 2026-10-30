import { withJsonRpc, type ProbeLaunch } from "@paws/provider-core/process";
import { acpModels } from "./catalogs.ts";

export async function discoverAcp(launch: ProbeLaunch) {
  return withJsonRpc(launch, async (rpc) => {
    await rpc.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "paws", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    const session = await rpc.request("session/new", {
      cwd: launch.cwd,
      mcpServers: [],
    });

    return { auth: "unknown" as const, models: acpModels(session) };
  });
}
