import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import {
  ensureEnvironment,
  environmentName,
  leaseToolRuntime,
  leaseCodexRuntime,
  stopEnvironment,
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
if (args[0] === 'container' && !existsSync(${JSON.stringify(`${root}/created-`)} + args.at(-1))) {
 console.error('Error: No such container'); process.exit(1);
}
if (args[0] === 'create') writeFileSync(${JSON.stringify(`${root}/created-`)} + args[2], 'created');
if (args[0] === 'start' && existsSync(${JSON.stringify(`${root}/fail-start`)})) process.exit(1);
if (args.some((arg) => arg.includes('apt-get install')) && existsSync(${JSON.stringify(`${root}/fail-bootstrap`)})) process.exit(1);
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
    await lease.cleanupSecrets();
    await expect(readFile(secret)).rejects.toThrow();
    const nextSecret = await lease.deliverSecret(randomUUID(), "next-turn");
    expect(await readFile(nextSecret, "utf8")).toBe("next-turn");
    await lease.dispose();
    await expect(readFile(nextSecret)).rejects.toThrow();
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

it("gives simultaneous MCP helpers disposable containers while retaining their shared auth home", async () => {
  await using fixture = await dockerFixture();
  const id = randomUUID();
  const first = await leaseToolRuntime(fixture.root, id, {
    sandbox: true,
    ephemeral: true,
  });
  await writeFile(
    `${fixture.root}/standalone/${id}/home/auth.json`,
    "saved-auth",
  );
  const second = await leaseToolRuntime(fixture.root, id, {
    sandbox: true,
    ephemeral: true,
  });
  expect(first.container).not.toBe(second.container);
  expect(
    await readFile(`${fixture.root}/standalone/${id}/home/auth.json`, "utf8"),
  ).toBe("saved-auth");
  await first.dispose();
  await second.dispose();
  const calls = await fixture.calls();
  const create = calls.find(([operation]) => operation === "create")!;
  expect(create).toContain("--rm");
  expect(create).toContain("--restart=no");
  expect(calls.filter(([operation]) => operation === "rm")).toEqual([
    ["rm", "--force", first.container],
    ["rm", "--force", second.container],
  ]);
});

it("removes disposable helper containers after startup or harness setup failures", async () => {
  await using fixture = await dockerFixture();
  await writeFile(`${fixture.root}/fail-start`, "fail");
  await expect(
    leaseToolRuntime(fixture.root, randomUUID(), {
      sandbox: true,
      ephemeral: true,
    }),
  ).rejects.toThrow();
  await rm(`${fixture.root}/fail-start`);
  await expect(
    leaseCodexRuntime(fixture.root, randomUUID(), "/missing/codex", {
      sandbox: true,
      ephemeral: true,
    }),
  ).rejects.toThrow();
  const calls = await fixture.calls();
  const names = calls
    .filter(([operation]) => operation === "create")
    .map((args) => args[2]);
  expect(calls.filter(([operation]) => operation === "rm")).toEqual(
    names.map((name) => ["rm", "--force", name]),
  );
});

it("reports failed persistent stops and permits retry after daemon recovery", async () => {
  await using fixture = await dockerFixture();
  const id = randomUUID();
  const lease = await leaseToolRuntime(fixture.root, id, { sandbox: true });
  await lease.dispose();
  await writeFile(`${fixture.root}/outage`, "offline");
  await expect(stopEnvironment(fixture.root, id, "agent")).rejects.toThrow();
  await rm(`${fixture.root}/outage`);
  await stopEnvironment(fixture.root, id, "agent");
  expect(
    (await fixture.calls()).filter(([operation]) => operation === "stop"),
  ).toEqual([
    ["stop", lease.container],
    ["stop", lease.container],
  ]);
});

it("starts saved team images and prepares missing runtime tools before provider commands", async () => {
  await using fixture = await dockerFixture();
  const image = `sha256:${"a".repeat(64)}`;
  const lease = await leaseToolRuntime(fixture.root, randomUUID(), {
    teamId: randomUUID(),
    template: image,
  });
  await lease.dispose();
  const calls = await fixture.calls();
  expect(calls.find(([operation]) => operation === "create")).toContain(image);
  const dependencies = calls.findIndex((args) =>
    args.some((arg) => arg.includes("apt-get install")),
  );
  const identity = calls.findIndex((args) =>
    args.some((arg) => arg.includes("useradd")),
  );
  expect(dependencies).toBeGreaterThan(0);
  expect(dependencies).toBeLessThan(identity);
  expect(calls[dependencies]?.join(" ")).toContain(
    "sudo util-linux procps ripgrep ffmpeg",
  );
});

it("retries dependency bootstrap failures without replacing the saved team image", async () => {
  await using fixture = await dockerFixture();
  const id = randomUUID();
  const environment = {
    teamId: randomUUID(),
    template: `sha256:${"b".repeat(64)}`,
  };
  await writeFile(`${fixture.root}/fail-bootstrap`, "fail");
  await expect(
    leaseToolRuntime(fixture.root, id, environment),
  ).rejects.toThrow();
  expect(
    (await fixture.calls()).some((args) =>
      args.some((arg) => arg.includes("useradd")),
    ),
  ).toBe(false);
  await rm(`${fixture.root}/fail-bootstrap`);
  const lease = await leaseToolRuntime(fixture.root, id, environment);
  await lease.dispose();
  expect(
    (await fixture.calls()).filter(([operation]) => operation === "create"),
  ).toHaveLength(1);
});
