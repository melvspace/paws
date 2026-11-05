import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseMetadataOnly } from "./release-metadata.mjs";

function snapshot(version) {
  return {
    "package.json": JSON.stringify({ version, scripts: { test: "pnpm test" } }),
    "apps/desktop/package.json": JSON.stringify({
      version,
      main: "src/main.mjs",
    }),
    "apps/mobile/app/build.gradle": `android {\n    versionName "${version}" // x-release-please-version\n}\n`,
    ".release-please-manifest.json": JSON.stringify({ ".": version }),
  };
}

test("allows synchronized versions and generated changelog", () => {
  assert.equal(
    releaseMetadataOnly(snapshot("0.1.0"), {
      ...snapshot("0.2.0"),
      "CHANGELOG.md": "Generated release notes",
    }),
    true,
  );
});

test("rejects executable, configuration, and unrelated source changes", () => {
  const mutations = [
    (next) => {
      next["package.json"] = JSON.stringify({
        version: "0.2.0",
        scripts: { test: "skip" },
      });
    },
    (next) => {
      next["apps/desktop/package.json"] = JSON.stringify({
        version: "0.2.0",
        main: "other.mjs",
      });
    },
    (next) => {
      next["apps/mobile/app/build.gradle"] += "\nexec { commandLine 'other' }";
    },
    (next) => {
      next["src/other.js"] = "code";
    },
    (next) => {
      next[".release-please-manifest.json"] = JSON.stringify({
        ".": "0.2.0",
        other: "1.0.0",
      });
    },
    (next) => {
      next["apps/desktop/package.json"] = JSON.stringify({
        version: "0.3.0",
        main: "src/main.mjs",
      });
    },
  ];

  for (const mutate of mutations) {
    const next = snapshot("0.2.0");
    mutate(next);
    assert.equal(releaseMetadataOnly(snapshot("0.1.0"), next), false);
  }
});

test("rejects unchanged versions", () => {
  assert.equal(
    releaseMetadataOnly(snapshot("0.1.0"), snapshot("0.1.0")),
    false,
  );
});
