import * as Fs from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { runCommand, withJsonRpc } from "./process.ts";

it("bounds a hung probe and terminates its process", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-process-");
  const pidFile = `${root}/pid`;

  try {
    await expect(
      runCommand({
        command: process.execPath,
        args: [
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
        ],
        cwd: root,
        signal: AbortSignal.timeout(250),
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
    const pid = Number(await Fs.readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("rejects native tool requests during catalog discovery and handles early process exit", async () => {
  const script = `
    const readline = require('readline').createInterface({input:process.stdin});
    process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:'tool', method:'fs/read_text_file', params:{path:'/sensitive'}})+'\\n');
    readline.on('line',line=>{ const m=JSON.parse(line); if(m.id==='tool' && m.error?.code===-32601) process.stdout.write(JSON.stringify({id:'1',result:'denied'})+'\\n'); });
  `;
  expect(
    await withJsonRpc(
      {
        command: process.execPath,
        args: ["-e", script],
        cwd: "/tmp/codex",
        signal: AbortSignal.timeout(2000),
      },
      (rpc) => rpc.request("model/list"),
    ),
  ).toBe("denied");
  await expect(
    withJsonRpc(
      {
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
        cwd: "/tmp/codex",
        signal: AbortSignal.timeout(2000),
      },
      (rpc) => rpc.request("initialize"),
    ),
  ).rejects.toMatchObject({ kind: "exit" });
});
