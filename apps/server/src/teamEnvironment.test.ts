import * as Fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vite-plus/test";
import {
  installTeamEnvironment,
  teamEnvironmentImage,
  teamRuntimeImage,
} from "./teamEnvironment.ts";

async function fixture() {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-team-environment-");
  const originalPath = process.env.PATH;
  await Fs.writeFile(
    join(root, "docker"),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const path = ${JSON.stringify(join(root, "calls"))};
appendFileSync(path, JSON.stringify(args) + '\\n');
if (args[0] === 'run') {
  if (args.at(-1) === 'fail') {
    console.error('missing dependency');
    process.exit(42);
  }
  if (args.at(-1) === 'wait') await new Promise(r => setTimeout(r, 30000));
  console.log('x'.repeat(300000));
}
if (args[0] === 'commit') {
  const count = readFileSync(path, 'utf8').split('"commit"').length - 1;
  console.log('sha256:' + String(count).repeat(64));
}
`,
    { mode: 0o700 },
  );
  process.env.PATH = root;

  return {
    root,
    async calls(): Promise<string[][]> {
      return (await Fs.readFile(join(root, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
    async dispose() {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;

      await Fs.rm(root, { recursive: true, force: true });
    },
  };
}

it("serializes team installations, persists their image across sessions and keeps credentials outside committed layers", async () => {
  const state = await fixture();
  const teamId = randomUUID();
  const signal = new AbortController().signal;

  try {
    expect(teamEnvironmentImage(state.root, teamId)).toBe(teamRuntimeImage);
    const [first, second] = await Promise.all([
      installTeamEnvironment(state.root, teamId, "first", signal),
      installTeamEnvironment(state.root, teamId, "second", signal),
    ]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.truncated).toBe(true);
    expect(first.stdout.length).toBeLessThanOrEqual(16000);
    expect(
      await Fs.stat(
        join(
          state.root,
          "teams",
          teamId,
          "files",
          first.log.split("/").at(-1)!,
        ),
      ),
    ).toMatchObject({ size: 300001 });
    const calls = await state.calls();
    const runs = calls.filter((call) => call[0] === "run");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain(teamRuntimeImage);
    expect(runs[1]).toContain(`sha256:${"1".repeat(64)}`);
    expect(teamEnvironmentImage(state.root, teamId)).toBe(
      `sha256:${"2".repeat(64)}`,
    );
    expect(teamEnvironmentImage(state.root, randomUUID())).toBe(
      teamRuntimeImage,
    );

    for (const run of runs) {
      expect(run).toContain("--user=0:0");
      expect(run).toContain("--cap-drop=ALL");
      expect(run).toContain("--security-opt=no-new-privileges");
      expect(run).not.toContain("--read-only");
      expect(run.join(" ")).not.toMatch(
        /team-auth|docker.sock|privileged|agents\//,
      );
      expect(run.filter((_arg, index) => run[index - 1] === "--mount")).toEqual(
        [
          `type=bind,src=${join(state.root, "teams", teamId, "files")},dst=/workspace,readonly`,
        ],
      );
      expect(calls).toContainEqual([
        "rm",
        "--force",
        run[run.indexOf("--name") + 1],
      ]);
    }
  } finally {
    await state.dispose();
  }
});

it("leaves the last successful image intact after a failed installation and returns diagnostics", async () => {
  const state = await fixture();
  const teamId = randomUUID();
  const signal = new AbortController().signal;

  try {
    await installTeamEnvironment(state.root, teamId, "success", signal);
    const image = teamEnvironmentImage(state.root, teamId);
    const failed = await installTeamEnvironment(
      state.root,
      teamId,
      "fail",
      signal,
    );
    expect(failed).toMatchObject({
      isError: true,
      exitCode: 42,
      stderr: "missing dependency\n",
    });
    expect(teamEnvironmentImage(state.root, teamId)).toBe(image);
    expect(
      (await state.calls()).filter((call) => call[0] === "commit"),
    ).toHaveLength(1);
    await installTeamEnvironment(state.root, teamId, "retry", signal);
    expect(teamEnvironmentImage(state.root, teamId)).not.toBe(image);
  } finally {
    await state.dispose();
  }
});

it("cleans up cancelled installations without publishing partial changes", async () => {
  const state = await fixture();
  const teamId = randomUUID();

  try {
    await expect(
      installTeamEnvironment(
        state.root,
        teamId,
        "wait",
        AbortSignal.timeout(300),
      ),
    ).rejects.toThrow();
    const calls = await state.calls();
    expect(calls.map((call) => call[0])).toEqual(["run", "rm"]);
    expect(teamEnvironmentImage(state.root, teamId)).toBe(teamRuntimeImage);
    await expect(
      installTeamEnvironment(
        state.root,
        teamId,
        "",
        new AbortController().signal,
      ),
    ).rejects.toThrow("installation script");
  } finally {
    await state.dispose();
  }
});
