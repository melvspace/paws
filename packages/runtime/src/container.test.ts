import { expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  containerArgs,
  leaseToolRuntime,
  writeRuntimeSecret,
} from "./container.ts";

it("mounts only the agent workspace, agent home and executable, without provider credentials or host privileges", () => {
  const args = containerArgs({
    name: "owned",
    workspace: "/state/agents/a/workspace",
    home: "/state/agents/a/home",
    binary: "/opt/codex",
    uid: 1000,
    gid: 1000,
  });
  const mounts = args.filter((_value, index) => args[index - 1] === "--mount");
  expect(mounts).toEqual([
    "type=bind,src=/state/agents/a/workspace,dst=/workspace",
    "type=bind,src=/state/agents/a/home,dst=/home/agent",
    "type=bind,src=/opt/codex,dst=/usr/local/bin/codex,readonly",
  ]);
  expect(args).toContain("--read-only");
  expect(args).toContain("--cap-drop=ALL");
  expect(args).toContain("--security-opt=no-new-privileges");
  expect(args).not.toContain("--privileged");
  expect(args.join(" ")).not.toMatch(
    /docker.sock|auth.json|--network=host|API_KEY/,
  );
  const other = containerArgs({
    name: "other",
    workspace: "/state/agents/b/workspace",
    home: "/state/agents/b/home",
    binary: "/opt/codex",
    uid: 1000,
    gid: 1000,
  });
  expect(other.join(" ")).not.toContain("agents/a");
});

it("delivers a secret over stdin, never argv or mounts, and reports safe delivery failures", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-secret-runtime-");
  const originalPath = process.env.PATH;
  const reference = randomUUID();
  const value = "test-secret-with-$(untrusted)-characters";

  try {
    await writeFile(
      `${root}/docker`,
      `#!${process.execPath}
import { writeFileSync } from 'node:fs';
let value = '';
for await (const chunk of process.stdin) value += chunk;
writeFileSync(${JSON.stringify(`${root}/captured`)}, JSON.stringify({ args: process.argv.slice(2), value }));
process.exit(process.argv.includes('fail-container') ? 1 : 0);
`,
      { mode: 0o700 },
    );
    process.env.PATH = root;
    expect(await writeRuntimeSecret("owned-container", reference, value)).toBe(
      `/tmp/paws-secrets/${reference}`,
    );
    const captured = JSON.parse(await readFile(`${root}/captured`, "utf8"));
    expect(captured.value).toBe(value);
    expect(captured.args).toContain("owned-container");
    expect(captured.args).toContain(`/tmp/paws-secrets/${reference}`);
    expect(captured.args.join(" ")).not.toContain(value);
    expect(captured.args.join(" ")).toContain("umask 077");
    await expect(
      writeRuntimeSecret("owned-container", "../escape", value),
    ).rejects.toThrow("Invalid secret reference");
    await expect(
      writeRuntimeSecret("fail-container", reference, value),
    ).rejects.toThrow("Could not deliver the secret to the agent runtime.");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;

    await rm(root, { recursive: true, force: true });
  }
});

it("cleans up a failed tool runtime launch and never mounts provider files", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-runtime-launch-");
  const originalPath = process.env.PATH;

  try {
    await writeFile(
      `${root}/docker`,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(`${root}/calls`)}, JSON.stringify(process.argv.slice(2))+'\\n');
process.exit(process.argv[2]==='run' ? 1 : 0);
`,
      { mode: 0o700 },
    );
    process.env.PATH = root;
    await expect(leaseToolRuntime(root, randomUUID())).rejects.toThrow(
      "Chat runtime unavailable",
    );
    const calls = (await readFile(`${root}/calls`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    const [launch, cleanup] = calls;
    expect(launch).toContain("--detach");
    expect(launch).toContain("--read-only");
    expect(
      launch.filter(
        (_value: string, index: number) => launch[index - 1] === "--mount",
      ),
    ).toHaveLength(2);
    expect(launch.join(" ")).not.toMatch(
      /auth.json|usr\/local\/bin|API_KEY|docker.sock/,
    );
    expect(cleanup).toEqual([
      "rm",
      "--force",
      launch[launch.indexOf("--name") + 1],
    ]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;

    await rm(root, { recursive: true, force: true });
  }
});
