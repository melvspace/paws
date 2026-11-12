import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureRuntimeCache(assets, manifest, install) {
  const expected = JSON.stringify(JSON.parse(manifest));
  const lock = `${assets}.lock`;

  async function ready() {
    try {
      return (
        JSON.stringify(
          JSON.parse(await readFile(join(assets, "ASSETS.json"), "utf8")),
        ) === expected
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false;

      throw error;
    }
  }

  await mkdir(dirname(assets), { recursive: true });

  for (let attempt = 0; attempt < 900; attempt++) {
    if (await ready()) return;

    try {
      await mkdir(lock);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;

      try {
        const owner = Number(await readFile(join(lock, "pid"), "utf8"));

        if (!Number.isSafeInteger(owner) || owner <= 0)
          throw new Error("Invalid runtime lock.");

        process.kill(owner, 0);
      } catch (ownerError) {
        if (
          ownerError instanceof Error &&
          "code" in ownerError &&
          ownerError.code === "ESRCH"
        ) {
          await rm(lock, { recursive: true, force: true });

          continue;
        }

        if (
          ownerError instanceof Error &&
          "code" in ownerError &&
          ownerError.code === "ENOENT"
        ) {
          const metadata = await stat(lock).catch(() => undefined);

          if (metadata && Date.now() - metadata.mtimeMs > 10_000) {
            await rm(lock, { recursive: true, force: true });

            continue;
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));

      continue;
    }

    try {
      await writeFile(join(lock, "pid"), String(process.pid), { mode: 0o600 });

      if (!(await ready())) await install(assets);

      return;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  throw new Error("Paws runtime preparation timed out. Restart Paws to retry.");
}
