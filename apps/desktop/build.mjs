import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bundleRuntimeAssets } from "./runtime-assets.mjs";
import { buildServer } from "../../scripts/build-server.mjs";

const root = resolve(import.meta.dirname, "../..");
const stage = join(import.meta.dirname, "dist");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await buildServer(join(stage, "server"));

await cp(join(root, "apps/web/dist"), join(stage, "web"), { recursive: true });
await cp(
  process.execPath,
  join(stage, process.platform === "win32" ? "node.exe" : "node"),
);
await cp(join(root, "LICENSE"), join(stage, "NODE-Paws-LICENSE"));

// Include the bundled Node runtime's license from the setup-node distribution.
const license = await fetch(
  `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
);

if (!license.ok) throw new Error("Unable to obtain the Node runtime license.");

await writeFile(join(stage, "NODE-LICENSE"), await license.text());

await bundleRuntimeAssets(join(stage, "containers"));
