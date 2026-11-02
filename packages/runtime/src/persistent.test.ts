import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import {
  ensureEnvironment,
  environmentName,
  leaseToolRuntime,
} from "./persistent.ts";

async function dockerFixture() {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-persistent-");
  const path = process.env.PATH;
  await writeFile(
    `${root}/docker`,
    `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(`${root}/calls`)}, JSON.stringify(args)+'\\n');
if (existsSync(${JSON.stringify(`${root}/outage`)})) { console.error('Cannot connect to Docker'); process.exit(1); }
if (args[0] === 'container' && !existsSync(${JSON.stringify(`${root}/created`)})) {
 console.error('Error: No such container'); process.exit(1);
}
if (args[0] === 'create') writeFileSync(${JSON.stringify(`${root}/created`)}, 'created');
`,
    { mode: 0o700 },
  );
  process.env.PATH = root;

  return {
    root,
    async calls(): Promise<string[][]> {
      return (await readFile(`${root}/calls`, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
    async [Symbol.asyncDispose]() {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;

      await rm(root, { recursive: true, force: true });
    },
  };
}

it("shares one retained writable environment, serializes creation, and never removes it on lease release", async () => {
  await using fixture = await dockerFixture();
  const teamId = randomUUID();
  const agentId = randomUUID();
  const otherId = randomUUID();
  const environment = { teamId, template: "custom-template:2" };
  const [first, second] = await Promise.all([
    leaseToolRuntime(fixture.root, agentId, environment),
    leaseToolRuntime(fixture.root, otherId, environment),
  ]);
  expect(first.container).toBe(second.container);
  expect(first.workspace).not.toBe(second.workspace);
  expect(first.workspace).toBe(`/team/agents/${agentId}/workspace`);
  await first.dispose();
  await second.dispose();
  const resumed = await leaseToolRuntime(fixture.root, agentId, environment);
  expect(resumed.container).toBe(first.container);
  await resumed.dispose();
  const calls = await fixture.calls();
  const creates = calls.filter(([operation]) => operation === "create");
  expect(creates).toHaveLength(1);
  const create = creates[0]!;
  expect(create).toContain("custom-template:2");
  expect(create).not.toContain("--read-only");
  expect(create).not.toContain("--rm");
  expect(create).not.toContain("--privileged");
  expect(
    create.filter((_item, index) => create[index - 1] === "--mount"),
  ).toEqual([`type=bind,src=${fixture.root}/teams/${teamId},dst=/team`]);
  expect(create.join(" ")).not.toMatch(
    /docker.sock|team-auth|provider-sessions|state.sqlite/,
  );
  expect(
    calls.some(([operation]) => operation === "rm" || operation === "stop"),
  ).toBe(false);
  expect(environmentName(fixture.root, teamId, "team")).not.toBe(
    environmentName(`${fixture.root}/other`, teamId, "team"),
  );
});

it("preserves an existing environment on daemon failure instead of recreating or deleting it", async () => {
  await using fixture = await dockerFixture();
  await writeFile(`${fixture.root}/outage`, "offline");
  await expect(
    ensureEnvironment(fixture.root, randomUUID(), { sandbox: true }),
  ).rejects.toThrow();
  expect((await fixture.calls()).map(([operation]) => operation)).toEqual([
    "container",
  ]);
});

it("runs standalone agents on the host by default, scopes their cwd/home, and removes delivered secrets", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-host-runtime-");

  try {
    const agentId = randomUUID();
    const lease = await leaseToolRuntime(root, agentId);
    expect(lease.isolation).toBe("host");
    expect(lease.container).toBeNull();
    expect(
      await lease.execute('printf %s "$HOME"', new AbortController().signal),
    ).toBe(lease.home);
    const secret = await lease.deliverSecret(randomUUID(), "private-input");
    expect(await readFile(secret, "utf8")).toBe("private-input");
    await lease.dispose();
    await expect(readFile(secret)).rejects.toThrow();
    expect(await lease.execute("pwd", new AbortController().signal)).toContain(
      `/standalone/${agentId}/workspace`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("kills a cancelled host process group without stopping other agent work", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-host-cancel-");
  const lease = await leaseToolRuntime(root, randomUUID());
  const abort = new AbortController();

  try {
    const running = lease.execute(
      "echo $$ > process.pid; sleep 300",
      abort.signal,
    );
    const failed = expect(running).rejects.toThrow();
    await expect
      .poll(async () => readFile(`${lease.workspace}/process.pid`, "utf8"))
      .toMatch(/\d+/);
    const pid = Number(
      await readFile(`${lease.workspace}/process.pid`, "utf8"),
    );
    abort.abort();
    await failed;
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect(
      await lease.execute("printf ready", new AbortController().signal),
    ).toBe("ready");
  } finally {
    abort.abort();
    await lease.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
