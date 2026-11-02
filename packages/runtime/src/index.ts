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

// Hold each parent directory open so a concurrent replacement cannot redirect a
// move through a link supplied by a team container.
function workspaceParent(root: string, relative: string) {
  const descriptors: number[] = [];
  const descriptorRoot =
    process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";

  try {
    let directory = root;

    for (const part of ["", ...relative.split(Path.sep)]) {
      if (part) {
        directory = Path.join(directory, part);

        try {
          SyncFs.mkdirSync(directory, { mode: 0o700 });
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "EEXIST"
            )
          )
            throw error;
        }
      }

      const descriptor = SyncFs.openSync(
        directory,
        SyncFs.constants.O_RDONLY |
          SyncFs.constants.O_DIRECTORY |
          SyncFs.constants.O_NOFOLLOW,
      );
      descriptors.push(descriptor);
      directory = Path.join(descriptorRoot, String(descriptor));
    }

    return {
      directory,
      close() {
        for (const descriptor of descriptors.reverse())
          SyncFs.closeSync(descriptor);
      },
    };
  } catch (error) {
    for (const descriptor of descriptors.reverse())
      SyncFs.closeSync(descriptor);

    throw error;
  }
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

  if (existing === destination) return layout;

  const wasAlias =
    existing !== undefined && SyncFs.lstatSync(layout.base).isSymbolicLink();
  const parent = workspaceParent(
    root,
    Path.relative(root, Path.dirname(destination)),
  );
  let source: ReturnType<typeof workspaceParent> | undefined;

  try {
    const target = Path.join(parent.directory, agentId);

    try {
      SyncFs.lstatSync(target);
      throw new Error("Agent destination already exists.");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }

    if (existing)
      source = workspaceParent(
        root,
        Path.relative(root, Path.dirname(existing)),
      );

    const original = source ? Path.join(source.directory, agentId) : undefined;

    if (original) SyncFs.renameSync(original, target);
    else SyncFs.mkdirSync(target, { mode: 0o700 });

    try {
      if (SyncFs.realpathSync(parent.directory) !== Path.dirname(destination))
        throw new Error("Workspace destination changed during relocation.");

      if (wasAlias) SyncFs.unlinkSync(layout.base);

      SyncFs.symlinkSync(destination, layout.base, "dir");
      resolveWorkspaceDirectory(root, agentId, ".");
    } catch (error) {
      if (
        SyncFs.lstatSync(layout.base, {
          throwIfNoEntry: false,
        })?.isSymbolicLink()
      )
        SyncFs.unlinkSync(layout.base);

      if (original) {
        SyncFs.renameSync(target, original);

        if (wasAlias) SyncFs.symlinkSync(existing!, layout.base, "dir");
      } else SyncFs.rmdirSync(target);

      throw error;
    }
  } finally {
    source?.close();
    parent.close();
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
