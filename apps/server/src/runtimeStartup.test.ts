import { expect, it, vi } from "vite-plus/test";
import { RuntimeSetupError } from "@paws/runtime";
import { initializeRuntime } from "./runtimeStartup.ts";

it("fails headless startup before accepting work without requesting OS authorization", async () => {
  const failure = new RuntimeSetupError(
    "/helper",
    "/binary",
    new Error("denied"),
  );
  const prepare = vi.fn().mockRejectedValue(failure);
  await expect(initializeRuntime("/isolated", { prepare })).rejects.toBe(
    failure,
  );
  expect(prepare).toHaveBeenCalledTimes(1);
});

it("checks the runtime again after explicit desktop startup authorization", async () => {
  const failure = new RuntimeSetupError(
    "/helper",
    "/binary",
    new Error("denied"),
  );
  const execute = vi.fn().mockResolvedValue({ stdout: "ready", stderr: "" });
  const prepare = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({ execute });
  const authorize = vi.fn().mockResolvedValue(undefined);
  await initializeRuntime("/isolated", { prepare, authorize });
  expect(authorize).toHaveBeenCalledExactlyOnceWith(failure);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledWith(["info"], { timeout: 10_000 });
});

it("does not request authorization for engine outages or continue after cancellation", async () => {
  const authorize = vi.fn().mockRejectedValue(new Error("cancelled"));
  const prepare = vi.fn().mockRejectedValue(new Error("engine offline"));
  await expect(
    initializeRuntime("/isolated", { prepare, authorize }),
  ).rejects.toThrow("engine offline");
  expect(authorize).not.toHaveBeenCalled();
  prepare.mockRejectedValue(
    new RuntimeSetupError("/helper", "/binary", undefined),
  );
  await expect(
    initializeRuntime("/isolated", { prepare, authorize }),
  ).rejects.toThrow("cancelled");
  expect(prepare).toHaveBeenCalledTimes(2);
});

it("rejects startup when the daemon is reachable but cannot start a sandbox", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ stdout: "ready", stderr: "" })
    .mockResolvedValueOnce({ stdout: "image", stderr: "" })
    .mockRejectedValueOnce(new Error("cgroup authorization denied"))
    .mockResolvedValueOnce({ stdout: "removed", stderr: "" });
  const prepare = vi.fn().mockResolvedValue({ execute });
  await expect(initializeRuntime("/isolated", { prepare })).rejects.toThrow(
    "failed its startup check",
  );
  expect(execute.mock.calls[2]?.[0]).toContain("--memory=32m");
  expect(execute.mock.calls[3]?.[0]).toContain("rm");
});
