import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const files = [
  "package.json",
  "apps/desktop/package.json",
  "apps/mobile/app/build.gradle",
  ".release-please-manifest.json",
  "CHANGELOG.md",
];

export function releaseMetadataOnly(before, after) {
  if (Object.keys(after).some((file) => !files.includes(file))) return false;

  const root = JSON.parse(after["package.json"]);
  const version = root.version;

  if (version === JSON.parse(before["package.json"]).version) return false;

  for (const file of ["package.json", "apps/desktop/package.json"]) {
    const previous = JSON.parse(before[file]);
    const next = JSON.parse(after[file]);

    if (next.version !== version) return false;

    delete previous.version;
    delete next.version;

    if (!isDeepStrictEqual(previous, next)) return false;
  }

  const manifest = ".release-please-manifest.json";
  const previous = JSON.parse(before[manifest]);
  const next = JSON.parse(after[manifest]);

  if (next["."] !== version) return false;

  delete previous["."];
  delete next["."];

  if (!isDeepStrictEqual(previous, next)) return false;

  const gradle = "apps/mobile/app/build.gradle";
  const marker =
    /^(\s*versionName ")[0-9]+\.[0-9]+\.[0-9]+(" \/\/ x-release-please-version)$/m;

  return (
    (after[gradle].match(marker)?.[0].includes(`"${version}"`) &&
      marker.test(before[gradle]) &&
      before[gradle].replace(marker, "$1VERSION$2") ===
        after[gradle].replace(marker, "$1VERSION$2")) === true
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: output } = process.env;

  if (!base || !head || !output)
    throw new Error("Missing CI comparison inputs.");

  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  const changed = git("diff", "--name-only", base, head).trim().split("\n");
  let metadata = false;

  if (changed.length && changed.every((file) => files.includes(file))) {
    const read = (sha) =>
      Object.fromEntries(
        files
          .filter((file) => file !== "CHANGELOG.md")
          .map((file) => [file, git("show", `${sha}:${file}`)]),
      );
    metadata = releaseMetadataOnly(read(base), read(head));
  }

  appendFileSync(output, `metadata=${metadata}\n`);
  console.log(
    metadata
      ? "Release metadata only; package builds run after merge."
      : "Source changes require full CI.",
  );
}
