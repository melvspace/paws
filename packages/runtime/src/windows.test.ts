import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vite-plus/test";
import {
  placeWorkspace,
  provisionWorkspace,
  leaseToolRuntime,
} from "./index.ts";

it.skipIf(process.platform !== "win32")(
  "moves personal files through Windows junctions and runs the native host shell",
  async () => {
    const temporary = join(tmpdir(), "codex");
    await mkdir(temporary, { recursive: true });
    const root = await mkdtemp(join(temporary, "paws-windows-"));
    const id = randomUUID();
    const first = randomUUID();
    const second = randomUUID();

    try {
      const layout = await provisionWorkspace(root, id);
      const personal = join(layout.workspace, "personal.txt");
      await writeFile(personal, "preserved");
      placeWorkspace(root, id, first);
      placeWorkspace(root, id, second);
      placeWorkspace(root, id, null);
      expect(await readFile(personal, "utf8")).toBe("preserved");
      const lease = await leaseToolRuntime(root, id);

      try {
        expect(lease.shell).toBe("powershell.exe");
        expect(
          await lease.execute(
            "Write-Output 'working'",
            new AbortController().signal,
          ),
        ).toContain("working");
        await expect(
          lease.execute(
            "Start-Sleep -Seconds 30",
            new AbortController().signal,
            { timeoutMs: 100 },
          ),
        ).rejects.toThrow();
      } finally {
        await lease.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
