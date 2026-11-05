import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

export async function buildServer(backend) {
  await rm(backend, { recursive: true, force: true });
  await mkdir(backend, { recursive: true });
  const pnpm = process.env.npm_execpath;

  if (!pnpm) throw new Error("Run the package script through pnpm.");

  const pnpmIsScript = /\.[cm]?js$/.test(pnpm);
  execFileSync(
    pnpmIsScript ? process.execPath : pnpm,
    [
      ...(pnpmIsScript ? [pnpm] : []),
      "--filter",
      "@paws/server",
      "deploy",
      "--prod",
      backend,
    ],
    { cwd: root, stdio: "inherit" },
  );

  // Node does not strip TypeScript inside node_modules. Compile Paws' own
  // sources while preserving the file layout used by provider helper processes.
  async function compile(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory() && entry.name !== "node_modules") {
        await compile(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        if (!entry.name.endsWith(".test.ts")) {
          const source = stripTypeScriptTypes(await readFile(path, "utf8"));
          await writeFile(
            path.replace(/\.ts$/, ".js"),
            source.replace(/\.ts(["'])/g, ".js$1"),
          );
        }

        await rm(path);
      }
    }
  }

  await compile(join(backend, "src"));

  for (const name of await readdir(join(root, "packages"))) {
    const directory = await realpath(
      join(backend, "node_modules/@paws", name),
    ).catch(() => undefined);

    if (!directory) continue;

    await compile(directory);
    const manifestPath = join(directory, "package.json");
    const manifest = await readFile(manifestPath, "utf8");
    await rm(manifestPath);
    await writeFile(manifestPath, manifest.replace(/\.ts"/g, '.js"'));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await buildServer(resolve(root, "dist/server"));
}
