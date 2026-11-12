import { expect, it, vi } from "vite-plus/test";
import { prepareLinuxSandbox, linuxDaemonEnvironment } from "./linuxSetup.ts";
import { containerEngine, ContainerRuntimeError } from "./engine.ts";

it("uses the existing sandbox without asking for authorization when it works", async () => {
  const run = vi.fn(async () => undefined);
  await prepareLinuxSandbox("/bundled", run);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith("/bundled/docker/rootlesskit", [
    "--net=none",
    "/bin/true",
  ]);
});

it("fails noninteractively when sandbox prerequisites are missing", async () => {
  const run = vi.fn().mockRejectedValue(new Error("newuidmap missing"));
  await expect(prepareLinuxSandbox("/bundled", run)).rejects.toThrow(
    "installation or deployment",
  );
  expect(run).toHaveBeenCalledTimes(1);
  expect(
    run.mock.calls.some(
      ([command]) => command === "pkexec" || command === "sudo",
    ),
  ).toBe(false);
});

it("reports a missing runtime as a runtime problem instead of a provider failure", async () => {
  await expect(
    containerEngine("/tmp/codex/paws-missing-docker").execute(["info"]),
  ).rejects.toBeInstanceOf(ContainerRuntimeError);
});

it("keeps the user authorization bus separate from private daemon state", () => {
  vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1234");
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1234/bus");
  vi.stubEnv("PAWS_TEST_SECRET", "not-for-the-daemon");

  try {
    const environment = linuxDaemonEnvironment(
      "/bundled/docker",
      "/private/paws/run",
    );
    expect(environment.XDG_RUNTIME_DIR).toBe("/run/user/1234");
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toBe(
      "unix:path=/run/user/1234/bus",
    );
    expect(environment.DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR).toBe(
      "/private/paws/run/rootlesskit",
    );
    expect(environment).not.toHaveProperty("PAWS_TEST_SECRET");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("derives the user bus from the login runtime directory when DBUS is unset", () => {
  vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1234");
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", undefined);

  try {
    expect(
      linuxDaemonEnvironment("/bundled/docker", "/private/paws/run")
        .DBUS_SESSION_BUS_ADDRESS,
    ).toBe("unix:path=/run/user/1234/bus");
  } finally {
    vi.unstubAllEnvs();
  }
});
