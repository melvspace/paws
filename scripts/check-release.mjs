import { readFile } from "node:fs/promises";

const root = JSON.parse(await readFile("package.json", "utf8"));
const desktop = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
const android = await readFile("apps/mobile/app/build.gradle", "utf8");
const version = root.version;
const parts = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);

if (
  !parts ||
  Number(parts[1]) > 2099 ||
  Number(parts[2]) > 999 ||
  Number(parts[3]) > 999
)
  throw new Error(
    "Use a stable version with major < 2100, minor and patch < 1000.",
  );

if (
  desktop.version !== version ||
  !android.includes(`versionName "${version}" // x-release-please-version`)
)
  throw new Error("Desktop, Android, and root versions must match.");

if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${version}`)
  throw new Error("Release tag does not match the checked-out app version.");

console.log(`Validated Paws ${version}.`);
