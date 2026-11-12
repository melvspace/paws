import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { ensureRuntimeCache } from "./runtime-cache.mjs";

test("concurrent startups install once, reuse assets, and release the installation lock", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-runtime-cache-");
  const assets = join(root, "assets");
  let installs = 0;
  const manifest = '[{"version":"fixture"}]';
  const install = async () => {
    installs++;
    await mkdir(assets);
    await writeFile(join(assets, "ASSETS.json"), manifest);
  };

  try {
    await Promise.all([
      ensureRuntimeCache(assets, manifest, install),
      ensureRuntimeCache(assets, manifest, install),
    ]);
    await ensureRuntimeCache(assets, manifest, install);
    assert.equal(installs, 1);
    await assert.rejects(access(`${assets}.lock`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed preparation releases its lock so the next launch can retry", async () => {
  const root = await mkdtemp("/tmp/codex/paws-runtime-cache-");
  const assets = join(root, "assets");

  try {
    await assert.rejects(
      ensureRuntimeCache(assets, "[]", async () => {
        throw new Error("download interrupted");
      }),
      /download interrupted/,
    );
    await ensureRuntimeCache(assets, "[]", async () => {
      await mkdir(assets);
      await writeFile(join(assets, "ASSETS.json"), "[]");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
