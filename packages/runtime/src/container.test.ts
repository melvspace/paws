import { expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { writeRuntimeSecret } from "./container.ts";

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
