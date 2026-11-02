import * as Fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  placeWorkspace,
  provisionWorkspace,
  workspaceLayout,
} from "./index.ts";

const hooks = vi.hoisted(() => ({
  opened: undefined as ((path: string) => void) | undefined,
  failAlias: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();

  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      hooks.opened?.(String(args[0]));

      return descriptor;
    },
    symlinkSync: (...args: Parameters<typeof actual.symlinkSync>) => {
      if (hooks.failAlias) throw new Error("Alias creation failed");

      return actual.symlinkSync(...args);
    },
  };
});

function fixture() {
  Fs.mkdirSync("/tmp/codex", { recursive: true });
  const root = Fs.mkdtempSync("/tmp/codex/paws-workspace-");

  return {
    root,
    [Symbol.dispose]() {
      hooks.opened = undefined;
      hooks.failAlias = false;
      Fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("migrates a real legacy directory once and preserves files across provisioning", async () => {
  using fixtureRoot = fixture();
  const id = randomUUID();
  const layout = workspaceLayout(fixtureRoot.root, id);
  Fs.mkdirSync(layout.workspace, { recursive: true });
  Fs.writeFileSync(join(layout.workspace, "personal"), "keep");
  await provisionWorkspace(fixtureRoot.root, id);
  await provisionWorkspace(fixtureRoot.root, id);
  expect(Fs.lstatSync(layout.base).isSymbolicLink()).toBe(true);
  expect(Fs.readFileSync(join(layout.workspace, "personal"), "utf8")).toBe(
    "keep",
  );
});

it("restores a real legacy directory when alias creation fails", () => {
  using fixtureRoot = fixture();
  const id = randomUUID();
  const layout = workspaceLayout(fixtureRoot.root, id);
  Fs.mkdirSync(layout.workspace, { recursive: true });
  Fs.writeFileSync(join(layout.workspace, "personal"), "keep");
  hooks.failAlias = true;
  expect(() => placeWorkspace(fixtureRoot.root, id, null)).toThrow(
    "Alias creation failed",
  );
  expect(Fs.lstatSync(layout.base).isDirectory()).toBe(true);
  expect(Fs.readFileSync(join(layout.workspace, "personal"), "utf8")).toBe(
    "keep",
  );
  expect(Fs.existsSync(join(fixtureRoot.root, "standalone", id))).toBe(false);
});

it("rejects destination links without moving personal files", async () => {
  using fixtureRoot = fixture();
  const id = randomUUID();
  const teamId = randomUUID();
  const layout = await provisionWorkspace(fixtureRoot.root, id);
  const previous = Fs.readlinkSync(layout.base);
  const team = join(fixtureRoot.root, "teams", teamId);
  const outside = join(fixtureRoot.root, "outside");
  Fs.mkdirSync(team, { recursive: true });
  Fs.mkdirSync(outside);
  Fs.symlinkSync(outside, join(team, "agents"));
  expect(() => placeWorkspace(fixtureRoot.root, id, teamId)).toThrow();
  expect(Fs.readlinkSync(layout.base)).toBe(previous);
  expect(Fs.readdirSync(outside)).toEqual([]);
});

it("rolls back when a container replaces an opened destination parent", async () => {
  using fixtureRoot = fixture();
  const id = randomUUID();
  const teamId = randomUUID();
  const layout = await provisionWorkspace(fixtureRoot.root, id);
  const previous = Fs.readlinkSync(layout.base);
  const parent = join(fixtureRoot.root, "teams", teamId, "agents");
  const displaced = `${parent}-old`;
  const outside = join(fixtureRoot.root, "outside");
  Fs.mkdirSync(parent, { recursive: true });
  Fs.mkdirSync(outside);
  hooks.opened = (path) => {
    if (Fs.realpathSync(path) !== parent) return;

    hooks.opened = undefined;
    Fs.renameSync(parent, displaced);
    Fs.symlinkSync(outside, parent);
  };
  expect(() => placeWorkspace(fixtureRoot.root, id, teamId)).toThrow(
    "destination changed",
  );
  expect(Fs.readlinkSync(layout.base)).toBe(previous);
  expect(Fs.readdirSync(outside)).toEqual([]);
  expect(Fs.readdirSync(displaced)).toEqual([]);
});
