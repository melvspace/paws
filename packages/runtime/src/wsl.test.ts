import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { wslArguments, wslDistribution, wslPath } from "./wsl.ts";

it("converts only host file arguments and preserves container commands", () => {
  expect(wslPath("C:\\Users\\Paws User\\.paws")).toBe(
    "/mnt/c/Users/Paws User/.paws",
  );
  expect(
    wslArguments([
      "create",
      "--mount",
      "type=bind,src=D:\\Paws\\teams\\one,dst=/team",
      "image",
      "echo",
      "C:\\unchanged",
    ]),
  ).toEqual([
    "create",
    "--mount",
    "type=bind,src=/mnt/d/Paws/teams/one,dst=/team",
    "image",
    "echo",
    "C:\\unchanged",
  ]);
  expect(
    wslArguments(["cp", "C:\\private\\auth", "container:/tmp/auth"]),
  ).toEqual(["cp", "/mnt/c/private/auth", "container:/tmp/auth"]);
  expect(wslArguments(["exec", "container", "echo", "C:\\literal"])).toEqual([
    "exec",
    "container",
    "echo",
    "C:\\literal",
  ]);
  expect(() => wslPath("\\\\server\\share")).toThrow("local Windows drive");
});

it("gives each application root a stable independent distribution", () => {
  expect(wslDistribution("C:\\one")).toBe(wslDistribution("C:\\one"));
  expect(wslDistribution("C:\\one")).not.toBe(wslDistribution("C:\\two"));
  expect(wslDistribution("C:\\one")).toMatch(/^Paws-[a-f0-9]{16}$/);
});

it.skipIf(process.platform === "win32")(
  "transfers integration secrets through WSLENV and stdin while pinning the engine socket",
  async () => {
    await mkdir("/tmp/codex", { recursive: true });
    const root = await mkdtemp("/tmp/codex/paws-wsl-bridge-");

    try {
      await writeFile(
        join(root, "wsl.exe"),
        `#!${process.execPath}
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => console.log(JSON.stringify({ args: process.argv.slice(2), exported: process.env.WSLENV, secret: process.env.PAWS_TEST_SECRET, input })));
`,
        { mode: 0o700 },
      );
      const result = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [
            fileURLToPath(new URL("./wslBridge.ts", import.meta.url)),
            wslDistribution(root),
            "exec",
            "--env",
            "PAWS_TEST_SECRET",
            "agent",
            "echo",
            "a b",
          ],
          {
            env: {
              ...process.env,
              PATH: root,
              PAWS_TEST_SECRET: "test-only-value",
            },
          },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
        child.stdin!.end("test-only-input");
      });
      const captured = JSON.parse(result);
      expect(captured.exported).toBe("PAWS_TEST_SECRET/u");
      expect(captured.secret).toBe("test-only-value");
      expect(captured.input).toBe("test-only-input");
      expect(captured.args).toContain("unix:///var/run/docker.sock");
      expect(captured.args).toContain("a b");
      expect(captured.args).not.toContain("test-only-value");
      expect(captured.args).not.toContain("test-only-input");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
