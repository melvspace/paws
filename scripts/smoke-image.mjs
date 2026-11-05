import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const image = process.argv[2] ?? "paws:local";
const name = `paws-smoke-${randomUUID()}`;
const docker = (...args) => exec("docker", args, { timeout: 120000 });

async function ready(origin) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${origin}/api/agents`, {
        signal: AbortSignal.timeout(1000),
      });

      if (response.ok && Array.isArray((await response.json()).agents)) return;
    } catch {
      // The container may still be starting.
    }

    await delay(200);
  }

  throw new Error("Container API did not become ready.");
}

try {
  await docker(
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::4310",
    image,
  );
  const port = (await docker("port", name, "4310/tcp")).stdout.trim();
  const origin = `http://${port}`;
  await ready(origin);
  const page = await fetch(origin);
  const html = await page.text();

  if (!page.ok || !html.includes('<div id="root">'))
    throw new Error("Container web client is missing.");

  const script = /src="([^"]+\.js)"/.exec(html)?.[1];

  if (!script || !(await fetch(new URL(script, origin))).ok)
    throw new Error("Container web assets are missing.");

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(origin.replace("http:", "ws:") + "/ws");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Container WebSocket did not return a snapshot."));
    }, 5000);
    socket.onmessage = (event) => {
      clearTimeout(timer);
      socket.close();

      try {
        if (!Array.isArray(JSON.parse(event.data).agents))
          throw new Error("Invalid container snapshot.");

        resolve();
      } catch (error) {
        reject(error);
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("Container WebSocket connection failed."));
    };
  });
  const identity = await docker("exec", name, "id", "-u");

  if (identity.stdout.trim() === "0")
    throw new Error("Container runs as root.");

  await docker("exec", name, "docker", "--version");
  await docker("stop", "--time", "10", name);
  const exit = await docker("inspect", "--format", "{{.State.ExitCode}}", name);

  if (exit.stdout.trim() !== "0")
    throw new Error("Container did not shut down cleanly on SIGTERM.");

  console.log(
    "Container UI, API, WebSocket, non-root user, Docker CLI, and shutdown passed.",
  );
} finally {
  await docker("rm", "--force", name).catch(() => {});
}
