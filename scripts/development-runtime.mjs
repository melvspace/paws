import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { ensureRuntimeCache } from "./runtime-cache.mjs";
import { bundleRuntimeAssets } from "../apps/desktop/runtime-assets.mjs";

let preparation;

export function prepareDevelopmentRuntime() {
  preparation ??= prepare().catch((error) => {
    preparation = undefined;

    throw error;
  });

  return preparation;
}

async function prepare() {
  const manifest = await readFile(
    new URL("../apps/desktop/runtime-assets.json", import.meta.url),
    "utf8",
  );
  const version = createHash("sha256")
    .update(manifest)
    .update(
      await readFile(
        new URL("../apps/desktop/runtime-assets.mjs", import.meta.url),
      ),
    )
    .update(
      await readFile(
        new URL(
          "../packages/runtime/setup/paws-runtime-setup",
          import.meta.url,
        ),
      ),
    )
    .digest("hex")
    .slice(0, 16);
  const assets =
    process.env.PAWS_RUNTIME_ASSETS ??
    join(
      homedir(),
      ".cache",
      "paws",
      "runtime",
      `${process.platform}-${process.arch}-${version}`,
    );
  await ensureRuntimeCache(assets, manifest, async (destination) => {
    console.log(
      "Paws is preparing its runtime. This only happens on first launch or after a runtime update.",
    );
    await bundleRuntimeAssets(destination);
  });

  process.env.PAWS_RUNTIME_ASSETS = assets;
  process.env.PATH = `${join(assets, "bin")}${delimiter}${process.env.PATH ?? ""}`;

  return assets;
}
