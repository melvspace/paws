import { beforeEach, expect, it, vi } from "vite-plus/test";
import { chromiumUserAgent, launchAgentBrowser } from "./browserRuntime.ts";

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
  launch: vi.fn((_command: string, _args: string[]) => {
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
  runtime.execute.mockImplementation((command) =>
    command === "/usr/bin/chromium --version"
      ? Promise.resolve("Chromium 148.0.7778.96")
      : new Promise<string>((resolve) => {
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

  const bridge = runtime.launch.mock.calls[0]![1][1]!;
  expect(bridge).toContain("--headless=new");
  expect(bridge).toContain("--disable-blink-features=AutomationControlled");
  expect(bridge).toContain("--remote-debugging-pipe");
  expect(runtime.launch.mock.calls[0]![1][3]).toBe(
    chromiumUserAgent("Chromium 148.0.7778.96", "linux"),
  );

  runtime.execute.mockRejectedValue(new Error("private-package-details"));
  await expect(
    launchAgentBrowser("/tmp/codex/browser-runtime-fixture", "one"),
  ).rejects.toThrow("Browser setup failed. Reconnect to retry.");
  expect(runtime.execute).toHaveBeenCalledTimes(4);
});

it("uses the installed browser major version and platform in the reduced UA", () => {
  expect(chromiumUserAgent("Chromium 148.0.7778.96", "linux")).toContain(
    "(X11; Linux x86_64)",
  );
  expect(
    chromiumUserAgent("Google Chrome for Testing 149.0.7800.1", "darwin"),
  ).toContain("(Macintosh; Intel Mac OS X 10_15_7)");
  expect(chromiumUserAgent("Chromium 150.0.1.2", "win32")).toContain(
    "(Windows NT 10.0; Win64; x64)",
  );
  expect(chromiumUserAgent("Chromium 150.0.1.2", "linux")).toContain(
    "Chrome/150.0.0.0",
  );
  expect(() => chromiumUserAgent("unknown")).toThrow(
    "Cannot determine Chromium version.",
  );
});

it("releases the runtime and hides details when browser version discovery fails", async () => {
  runtime.execute.mockResolvedValueOnce("");
  runtime.execute.mockResolvedValueOnce("private-invalid-version-details");
  await expect(
    launchAgentBrowser("/tmp/codex/browser-runtime-fixture", "one"),
  ).rejects.toThrow("Browser could not start. Reconnect to retry.");
  expect(runtime.dispose).toHaveBeenCalledTimes(1);
  expect(runtime.launch).not.toHaveBeenCalled();
});
