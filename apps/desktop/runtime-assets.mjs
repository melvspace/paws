import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const manifest = JSON.parse(
  await readFile(new URL("./runtime-assets.json", import.meta.url), "utf8"),
);

export async function bundleRuntimeAssets(destination, target = {}) {
  const platform = target.platform ?? process.platform;
  const architecture = target.arch ?? process.arch;

  if (platform === "win32" && architecture !== "x64")
    throw new Error("The Windows managed runtime requires x64.");

  if (!["x64", "arm64"].includes(architecture))
    throw new Error("Unsupported runtime architecture.");

  const arch = architecture === "arm64" ? "aarch64" : "x86_64";
  const temporaryRoot =
    process.platform === "win32" ? join(tmpdir(), "codex") : "/tmp/codex";
  await mkdir(temporaryRoot, { recursive: true });
  const temporary = await mkdtemp(join(temporaryRoot, "paws-assets-"));
  await mkdir(destination, { recursive: true });

  async function download(name) {
    const asset = name.startsWith("https://")
      ? manifest.find((item) => item.url === name)
      : manifest.find((item) => basename(item.url) === name);

    if (!asset) throw new Error(`Missing pinned runtime asset: ${name}`);

    const response = await fetch(asset.url);

    if (!response.ok)
      throw new Error(`Unable to download ${name}: ${response.status}`);

    const bytes = Buffer.from(await response.arrayBuffer());

    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error(`Runtime asset checksum mismatch: ${name}`);

    return { bytes, asset };
  }

  async function extract(name, target, entries = []) {
    const { bytes, asset } = await download(name);
    const archive = join(temporary, basename(asset.url));
    await writeFile(archive, bytes);
    await mkdir(target, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", target, ...entries]);
  }

  async function codex(platform, target) {
    for (const name of ["codex", "codex-code-mode-host", "codex-exec-server"]) {
      const filename = `${name}-${arch}-${platform}`;

      if (!manifest.some((item) => basename(item.url) === `${filename}.tar.gz`))
        continue;

      const staging = join(temporary, filename);
      await extract(`${filename}.tar.gz`, staging);
      const files = await readdir(staging);
      const binary = files.find((file) => file === filename || file === name);

      if (!binary) throw new Error(`Missing ${name} in runtime archive.`);

      await mkdir(target, { recursive: true });
      await cp(join(staging, binary), join(target, name));
    }
  }

  // Select Docker assets explicitly because their filenames are identical.
  async function docker(os, target, rootless = false) {
    const segment = `${os}/static/stable/${arch}/`;
    const matches = manifest.filter((item) => item.url.includes(segment));
    const staging = join(
      temporary,
      `${os}-${rootless ? "rootless" : "engine"}`,
    );
    const asset = matches.find((item) =>
      basename(item.url).startsWith(
        rootless ? "docker-rootless-extras-" : "docker-29",
      ),
    );

    if (!asset) throw new Error(`Missing Docker assets for ${os}/${arch}.`);

    await extract(asset.url, staging);
    await cp(
      join(staging, rootless ? "docker-rootless-extras" : "docker"),
      target,
      { recursive: true },
    );
  }

  try {
    await docker(
      "linux",
      join(destination, platform === "linux" ? "docker" : "docker-linux"),
    );

    if (platform === "linux") {
      await docker("linux", join(destination, "docker"), true);
    } else if (platform === "darwin") {
      await docker("mac", join(destination, "docker"));
      await extract(
        `lima-2.3.0-Darwin-${architecture === "arm64" ? "arm64" : "x86_64"}.tar.gz`,
        join(destination, "lima"),
      );
    }

    const buildxPlatform = platform === "darwin" ? "darwin" : "linux";
    const buildxArch = architecture === "arm64" ? "arm64" : "amd64";
    const plugin = manifest.find((item) =>
      basename(item.url).endsWith(`.${buildxPlatform}-${buildxArch}`),
    );

    if (!plugin) throw new Error("Missing bundled image builder.");

    const plugins = join(
      destination,
      platform === "win32" ? "docker-linux" : "plugins",
    );
    await mkdir(plugins, { recursive: true });
    const { bytes } = await download(plugin.url);
    await writeFile(join(plugins, "docker-buildx"), bytes);
    await chmod(join(plugins, "docker-buildx"), 0o755);

    await codex("unknown-linux-musl", join(destination, "codex-linux"));

    if (platform === "win32") {
      const { bytes } = await download("ubuntu-24.04.4-wsl-amd64.wsl");
      await writeFile(join(destination, "ubuntu.wsl"), bytes);
      await mkdir(join(destination, "bin"), { recursive: true });

      for (const name of [
        "codex",
        "codex-code-mode-host",
        "codex-exec-server",
      ]) {
        const asset = manifest.find(
          (item) => basename(item.url) === `${name}-x86_64-pc-windows-msvc.exe`,
        );

        if (!asset) continue;

        const { bytes } = await download(asset.url);
        await writeFile(join(destination, "bin", `${name}.exe`), bytes);
      }
    } else
      await codex(
        platform === "darwin" ? "apple-darwin" : "unknown-linux-musl",
        join(destination, "bin"),
      );
    await mkdir(join(destination, "licenses"), { recursive: true });

    for (const asset of manifest.filter((item) => item.license)) {
      const { bytes } = await download(asset.url);
      await writeFile(
        join(destination, "licenses", `${asset.license}-LICENSE`),
        bytes,
      );
    }

    await cp(
      new URL("../../packages/runtime/docker/", import.meta.url),
      join(destination, "image"),
      { recursive: true },
    );
    await cp(
      new URL("../../packages/runtime/setup/", import.meta.url),
      join(destination, "setup"),
      { recursive: true },
    );
    await writeFile(
      join(destination, "ASSETS.json"),
      JSON.stringify(manifest, null, 2),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
