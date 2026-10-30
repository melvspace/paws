import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { assertAgentId } from "@paws/shared";

export function workspaceLayout(root: string, agentId: string) {
  assertAgentId(agentId);
  const base = Path.resolve(root, "agents", agentId);

  return {
    base,
    workspace: Path.join(base, "workspace"),
    home: Path.join(base, "home"),
    codexHome: Path.join(base, "home", ".codex"),
    skills: Path.join(base, "home", ".agents", "skills"),
    browserProfile: Path.join(base, "browser"),
  };
}

export async function provisionWorkspace(root: string, agentId: string) {
  const layout = workspaceLayout(root, agentId);
  await Promise.all(
    Object.values(layout).map((path) =>
      Fs.mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );

  return layout;
}

// A runtime must enforce these boundaries before provider execution is enabled.
export interface RuntimeLease {
  readonly agentId: string;
  readonly isolation: "container";
  readonly workspace: string;
  readonly home: string;
  readonly browserProfile: string;
  readonly shell: string;
  readonly tools: ReadonlyArray<string>;
  dispose(): Promise<void>;
}
