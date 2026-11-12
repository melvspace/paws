import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeSetupRequest } from "./src/runtimeSetup.mjs";

test(
  "desktop setup accepts only matching runtime installation paths",
  { skip: process.platform !== "linux" },
  () => {
    const root = "/tmp/codex/paws-setup-fixture";
    const installation = `${root}/runtime/installation/0123456789abcdef`;
    const request = {
      type: "runtime-setup-required",
      id: "fixture",
      helper: `${installation}/setup/paws-runtime-setup`,
      binary: `${installation}/docker/rootlesskit`,
    };
    assert.deepEqual(runtimeSetupRequest(request, root), {
      id: request.id,
      helper: request.helper,
      binary: request.binary,
    });
    assert.equal(
      runtimeSetupRequest({ ...request, helper: "/tmp/other-helper" }, root),
      null,
    );
    assert.equal(
      runtimeSetupRequest({ ...request, binary: "/usr/bin/rootlesskit" }, root),
      null,
    );
    assert.equal(
      runtimeSetupRequest({ ...request, type: "message" }, root),
      null,
    );
  },
);
