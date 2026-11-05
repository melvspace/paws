import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const unpacked =
  process.platform === "darwin"
    ? `${process.arch === "arm64" ? "mac-arm64" : "mac"}/Paws.app/Contents/Resources`
    : `${process.platform === "win32" ? "win" : "linux"}-unpacked/resources`;
const runtime = resolve("release/desktop", unpacked, "runtime");
const home = await mkdtemp(join(tmpdir(), "paws-package-"));
// An initialized, empty provider table prevents first-run CLI discovery during
// the smoke test, including on developer machines with authenticated providers.
const database = new DatabaseSync(join(home, "state.sqlite"));
database.exec(
  "CREATE TABLE providers (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
);
database.close();
const child = spawn(
  join(runtime, process.platform === "win32" ? "node.exe" : "node"),
  [join(runtime, "server/src/main.js")],
  {
    cwd: runtime,
    env: {
      ...process.env,
      PAWS_HOME: home,
      PAWS_WEB_ROOT: join(runtime, "web"),
      PAWS_COMPANION_ORIGIN: "",
      PAWS_COMPANION_TOKEN_FILE: "",
      PAWS_WEBHOOK_PORT: "",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  },
);
const exited = new Promise((resolve) => {
  child.once("exit", resolve);
  child.once("error", resolve);
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Packaged server did not start.")),
      30000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Packaged server exited: ${stderr}`));
    });
    child.once("message", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const page = await fetch("http://127.0.0.1:4310");

  if (!page.ok || !(await page.text()).includes('<div id="root">'))
    throw new Error("Packaged web client is missing.");

  const api = await fetch("http://127.0.0.1:4310/api/agents");

  if (!api.ok || !Array.isArray((await api.json()).agents))
    throw new Error("Packaged API did not return an agent snapshot.");

  console.log("Packaged backend and web client started successfully.");
} finally {
  if (child.connected) child.disconnect();

  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  await exited;
  clearTimeout(timer);
  await rm(home, { recursive: true, force: true });
}
