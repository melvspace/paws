import * as Fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vite-plus/test";
import {
  startTeamCommand,
  readTeamCommand,
  closeTeamCommands,
  listTeamCommands,
} from "./teamCommandSessions.ts";

async function fixture() {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-session-lifecycle-");
  const originalPath = process.env.PATH;
  const teamId = randomUUID();
  await Fs.writeFile(
    join(root, "docker"),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const root = ${JSON.stringify(root)};
appendFileSync(root+'/calls', JSON.stringify(args)+'\\n');
const flag = name => existsSync(root+'/'+name);
if (args[0] === 'run') {
  if (flag('launch-failed')) process.exit(1);
  console.log('container-id');
} else if (args[0] === 'inspect') {
  if (flag('missing')) {console.error('No such object');process.exit(1);}
  if (flag('offline')) {console.error('Cannot connect to Docker');process.exit(1);}
  console.log(JSON.stringify({Status:flag('exit-code')?'exited':'running', ExitCode:flag('exit-code')?Number(readFileSync(root+'/exit-code','utf8')):0}));
} else if (args[0] === 'logs') {
  if (flag('logs-failed')) process.exit(1);
  if (flag('large')) process.stdout.write('x'.repeat(300000)+'\\n');
  console.log('command output');
  console.error('command diagnostics');
} else if (args[0] === 'rm' && flag('remove-failed')) {
  console.error('Cannot connect to Docker');process.exit(1);
}
`,
    { mode: 0o700 },
  );
  process.env.PATH = root;
  const start = (integrationId = "custom", args: string[] = []) =>
    startTeamCommand({
      root,
      teamId,
      integrationId,
      args,
      image: "test-image",
      secrets: {},
      commandArgs: [
        "run",
        "--rm",
        "--interactive",
        "--name",
        "placeholder",
        "test-image",
        "custom-cli",
        ...args,
      ],
      signal: new AbortController().signal,
      redact: (text) => text,
    });
  const read = (id: string, cancel = false) =>
    readTeamCommand(root, teamId, id, (text) => text, cancel);

  return {
    root,
    teamId,
    start,
    read,
    flag: (name: string, value = "yes") =>
      Fs.writeFile(join(root, name), value),
    clear: (name: string) => Fs.rm(join(root, name)),
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

it("retains failure diagnostics and bounded output without killing a command for large logs", async () => {
  const state = await fixture();

  try {
    await state.flag("large");
    const running = await state.start("custom", ["--rm"]);
    expect(running.status).toBe("running");
    expect(running.truncated).toBe(true);
    expect(running.stdout).toContain("command output");
    expect(running.stdout.length).toBeLessThan(64001);
    const launch = (await state.calls())[0];

    if (!launch) throw new Error("Expected a container launch.");

    expect(launch.slice(launch.indexOf("test-image") + 1)).toContain("--rm");
    await state.flag("exit-code", "42");
    const failed = await state.read(running.sessionId);
    expect(failed).toMatchObject({
      status: "failed",
      isError: true,
      exitCode: 42,
      stderr: "command diagnostics\n",
    });
    expect(await state.read(running.sessionId)).toEqual(failed);
    expect((await state.calls()).at(-1)?.[0]).toBe("rm");
  } finally {
    await state.dispose();
  }
});

it("cleans up failed launches and cancellation, and scopes administrative cleanup to removed integrations", async () => {
  const state = await fixture();

  try {
    await state.flag("launch-failed");
    await expect(state.start()).rejects.toThrow(
      "Could not start command session",
    );
    expect(listTeamCommands(state.root, state.teamId)).toEqual([]);
    expect((await state.calls()).at(-1)?.[0]).toBe("rm");
    await state.clear("launch-failed");
    const running = await state.start();
    await state.flag("logs-failed");
    expect(await state.read(running.sessionId, true)).toMatchObject({
      status: "cancelled",
    });
    await state.clear("logs-failed");
    const kept = await state.start("keep");
    const removed = await state.start("remove");
    await closeTeamCommands(state.root, randomUUID());
    expect((await state.read(kept.sessionId)).status).toBe("running");
    await state.flag("remove-failed");
    await expect(
      closeTeamCommands(state.root, state.teamId, ["keep"]),
    ).rejects.toThrow();
    expect((await state.read(removed.sessionId)).status).toBe("running");
    await state.clear("remove-failed");
    await closeTeamCommands(state.root, state.teamId, ["keep"]);
    expect((await state.read(kept.sessionId)).status).toBe("running");
    expect((await state.read(removed.sessionId)).status).toBe("cancelled");
    await closeTeamCommands(state.root);
    expect((await state.read(kept.sessionId)).status).toBe("cancelled");
  } finally {
    await state.dispose();
  }
});

it("preserves sessions during Docker outages, reports lost containers, and prevents duplicate concurrent starts", async () => {
  const state = await fixture();

  try {
    const [first, duplicate] = await Promise.all([
      state.start(),
      state.start(),
    ]);
    expect(first.sessionId).toBe(duplicate.sessionId);
    expect(
      (await state.calls()).filter((call) => call[0] === "run"),
    ).toHaveLength(1);
    await expect(state.start("custom", ["different"])).rejects.toThrow(
      "Read or cancel it first",
    );
    await state.flag("offline");
    await expect(state.read(first.sessionId)).rejects.toThrow(
      "session has not been replaced",
    );
    await state.clear("offline");
    expect((await state.read(first.sessionId)).status).toBe("running");
    await expect(
      readTeamCommand(
        state.root,
        randomUUID(),
        first.sessionId,
        (text) => text,
      ),
    ).rejects.toThrow("another team");
    await state.flag("missing");
    expect(await state.read(first.sessionId)).toMatchObject({
      status: "failed",
      exitCode: 127,
    });
    await state.clear("missing");
    const replacement = await state.start();
    expect(replacement.sessionId).not.toBe(first.sessionId);
    await state.flag("exit-code", "124");
    expect(await state.read(replacement.sessionId)).toMatchObject({
      status: "failed",
      exitCode: 124,
    });
  } finally {
    await state.dispose();
  }
});
