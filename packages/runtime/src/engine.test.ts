import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { containerEngine, getContainerEngine } from "./engine.ts";

async function fixture() {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-engine-");
  const assets = join(root, "assets");
  const previous = process.env.PAWS_RUNTIME_ASSETS;
  await mkdir(join(assets, "docker"), { recursive: true });
  await writeFile(
    join(assets, "docker", "docker"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(process.argv.includes("--config") ? 6 : 4);
fs.appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (fs.existsSync(${JSON.stringify(join(root, "outage"))})) { console.error('Cannot connect to daemon'); process.exit(1); }
if (args[0] === 'image' && !fs.existsSync(${JSON.stringify(join(root, "image"))})) { console.error('No such image'); process.exit(1); }
if (args[0] === 'build') fs.writeFileSync(${JSON.stringify(join(root, "image"))}, 'built');
`,
    { mode: 0o700 },
  );
  process.env.PAWS_RUNTIME_ASSETS = assets;

  return {
    root,
    assets,
    async calls(): Promise<string[][]> {
      return (await readFile(join(root, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
    async [Symbol.asyncDispose]() {
      if (previous === undefined) delete process.env.PAWS_RUNTIME_ASSETS;
      else process.env.PAWS_RUNTIME_ASSETS = previous;

      await rm(root, { recursive: true, force: true });
    },
  };
}

it("preserves argument boundaries and engine prefixes for streaming commands", () => {
  const engine = containerEngine("/bundled/docker", [
    "--host",
    "unix:///private/socket",
  ]);
  expect(engine.launch(["exec", "container", "echo", "a b"])).toEqual({
    command: "/bundled/docker",
    args: [
      "--host",
      "unix:///private/socket",
      "exec",
      "container",
      "echo",
      "a b",
    ],
  });
});

it.skipIf(process.platform !== "linux")(
  "prepares one managed image concurrently and reuses it without requiring Docker on PATH",
  async () => {
    await using test = await fixture();
    const [first, second] = await Promise.all([
      getContainerEngine(test.root),
      getContainerEngine(test.root),
    ]);
    expect(first).toBe(second);
    expect(first.user).toBe("0:0");
    expect(first.launch(["exec", "agent"]).command).toBe(
      join(test.assets, "docker", "docker"),
    );
    await getContainerEngine(test.root);
    const calls = await test.calls();
    expect(calls.filter((args) => args.includes("build"))).toHaveLength(1);
    expect(await readFile(join(test.root, "runtime", "engine"), "utf8")).toBe(
      "managed",
    );
    expect(
      calls.every(
        (args) =>
          args[1] === `unix://${join(test.root, "runtime", "docker.sock")}`,
      ),
    ).toBe(true);
  },
);

it("keeps existing persisted environments on their original Docker engine", async () => {
  await using test = await fixture();
  await mkdir(join(test.root, "runtime", "environments"), { recursive: true });
  await writeFile(join(test.root, "runtime", "environments", "retained"), "");
  const engine = await getContainerEngine(test.root);
  expect(engine.launch(["start", "retained"])).toEqual({
    command: "docker",
    args: ["start", "retained"],
  });
  expect(await readFile(join(test.root, "runtime", "engine"), "utf8")).toBe(
    "docker",
  );
});

it.skipIf(process.platform !== "linux")(
  "does not rebuild on an image inspection outage and permits retry",
  async () => {
    await using test = await fixture();
    // Leave info healthy while image inspection fails with a daemon error.
    const binary = join(test.assets, "docker", "docker");
    const original = await readFile(binary, "utf8");
    await writeFile(
      binary,
      original.replace(
        "if (args[0] === 'image'",
        "if (args[0] === 'image') { console.error('Cannot connect to daemon'); process.exit(1); }\nif (args[0] === 'image'",
      ),
    );
    await expect(getContainerEngine(test.root)).rejects.toThrow();
    expect((await test.calls()).some((args) => args.includes("build"))).toBe(
      false,
    );
    await writeFile(binary, original);
    await expect(getContainerEngine(test.root)).resolves.toBeDefined();
  },
);
