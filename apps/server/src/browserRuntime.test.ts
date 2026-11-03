import { beforeEach, expect, it, vi } from "vite-plus/test";
import { launchAgentBrowser } from "./browserRuntime.ts";

const runtime = vi.hoisted(() => ({
  execute:
    vi.fn<
      (
        command: string,
        signal: AbortSignal,
        options?: { timeoutMs?: number },
      ) => Promise<string>
    >(),
  dispose: vi.fn(async () => {}),
  launch: vi.fn(() => {
    throw new Error("private-launch-details");
  }),
}));
vi.mock("./teamContext.ts", () => ({
  agentContext: () => ({ memory: "", teams: [] }),
}));
vi.mock("@paws/runtime", async (original) => ({
  ...(await original<typeof import("@paws/runtime")>()),
  leaseToolRuntime: async () => ({
    ...runtime,
    container: "shared-browser-fixture",
    browserProfile: "/agent/browser",
  }),
}));

beforeEach(() => {
  runtime.execute.mockReset();
  runtime.dispose.mockClear();
  runtime.launch.mockClear();
});

it("shares dependency preparation between teammates, allows slow first installs, and retries failures", async () => {
  let release: (output: string) => void = () => {};
  runtime.execute.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const first = launchAgentBrowser("/tmp/codex/browser-runtime-fixture", "one");
  const second = launchAgentBrowser(
    "/tmp/codex/browser-runtime-fixture",
    "two",
  );
  const outcomes = Promise.allSettled([first, second]);
  await vi.waitFor(() => expect(runtime.execute).toHaveBeenCalledTimes(1));
  const [, signal, options] = runtime.execute.mock.calls[0]!;
  expect(signal.aborted).toBe(false);
  expect(options?.timeoutMs).toBeGreaterThan(120000);
  release("");
  expect((await outcomes).map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(runtime.dispose).toHaveBeenCalledTimes(2);
  runtime.execute.mockRejectedValue(new Error("private-package-details"));
  await expect(
    launchAgentBrowser("/tmp/codex/browser-runtime-fixture", "one"),
  ).rejects.toThrow("Browser setup failed. Reconnect to retry.");
  expect(runtime.execute).toHaveBeenCalledTimes(2);
});
