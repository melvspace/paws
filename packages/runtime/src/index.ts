import * as Fs from "node:fs/promises";
import * as SyncFs from "node:fs";
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

// Resolve the server's alias without trusting symlinks created inside a runtime.
export function resolveWorkspaceDirectory(
  root: string,
  agentId: string,
  folder: string,
) {
  const layout = workspaceLayout(root, agentId);
  const alias = SyncFs.lstatSync(layout.base).isSymbolicLink()
    ? Path.resolve(Path.dirname(layout.base), SyncFs.readlinkSync(layout.base))
    : layout.base;
  const relative = Path.relative(Path.resolve(root), alias);
  const team = /^teams\/([^/]+)\/agents\/([^/]+)$/.exec(relative);

  if (
    alias !== layout.base &&
    relative !== `standalone/${agentId}` &&
    !(team && team[2] === agentId)
  )
    throw new Error("Invalid workspace location.");

  if (team) assertAgentId(team[1]!);

  const base = SyncFs.realpathSync(layout.base);
  const directory = SyncFs.realpathSync(Path.join(layout.base, folder));

  if (
    base !== alias ||
    (directory !== base && !directory.startsWith(`${base}/`))
  ) {
    throw new Error("Workspace directory escaped its environment.");
  }

  return directory;
}

// The server-only alias keeps personal file references stable across team moves.
export function placeWorkspace(
  root: string,
  agentId: string,
  teamId: string | null,
) {
  if (teamId) assertAgentId(teamId);

  const layout = workspaceLayout(root, agentId);
  SyncFs.mkdirSync(Path.dirname(layout.base), { recursive: true, mode: 0o700 });
  const destination = teamId
    ? Path.resolve(root, "teams", teamId, "agents", agentId)
    : Path.resolve(root, "standalone", agentId);
  const existing = SyncFs.existsSync(layout.base)
    ? resolveWorkspaceDirectory(root, agentId, ".")
    : undefined;
  SyncFs.mkdirSync(Path.dirname(destination), { recursive: true, mode: 0o700 });

  if (existing !== destination) {
    if (SyncFs.existsSync(destination))
      throw new Error("Agent destination already exists.");

    if (existing) SyncFs.renameSync(existing, destination);
    else SyncFs.mkdirSync(destination, { recursive: true, mode: 0o700 });

    try {
      if (existing) SyncFs.unlinkSync(layout.base);
      SyncFs.symlinkSync(destination, layout.base, "dir");
    } catch (error) {
      if (existing) {
        SyncFs.renameSync(destination, existing);
        if (!SyncFs.existsSync(layout.base))
          SyncFs.symlinkSync(existing, layout.base, "dir");
      }

      throw error;
    }
  }

  return layout;
}

export async function provisionWorkspace(
  root: string,
  agentId: string,
  teamId: string | null = null,
) {
  const layout = placeWorkspace(root, agentId, teamId);
  await Promise.all(
    Object.values(layout).map((path) =>
      Fs.mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );

  return layout;
}

export function executionPaths(
  root: string,
  agentId: string,
  environment: { teamId?: string | null; sandbox?: boolean } = {},
) {
  const layout = workspaceLayout(root, agentId);
  const base = environment.teamId
    ? `/team/agents/${agentId}`
    : environment.sandbox
      ? "/agent"
      : layout.base;

  return {
    workspace: `${base}/workspace`,
    home: `${base}/home`,
    browserProfile: `${base}/browser`,
  };
}

// A runtime must enforce these boundaries before provider execution is enabled.
export interface RuntimeLease {
  readonly agentId: string;
  readonly isolation: "container" | "host";
  readonly workspace: string;
  readonly home: string;
  readonly browserProfile: string;
  readonly shell: string;
  readonly tools: ReadonlyArray<string>;
  dispose(): Promise<void>;
}

export {
  leaseCodexRuntime,
  leaseToolRuntime,
  ensureEnvironment,
  environmentName,
  stopEnvironment,
} from "./persistent.ts";
