import { app, BrowserWindow, dialog } from "electron";
import { spawn } from "node:child_process";
import { join } from "node:path";

/** @type {import("node:child_process").ChildProcess | undefined} */
let backend;
let stopping = false;
const origin = app.isPackaged
  ? "http://127.0.0.1:4310"
  : "http://localhost:5173";

if (!app.requestSingleInstanceLock()) app.exit();

await app.whenReady();

async function startBackend() {
  let started = false;
  const runtime = join(process.resourcesPath, "runtime");
  const child = spawn(
    join(runtime, process.platform === "win32" ? "node.exe" : "node"),
    [join(runtime, "server/src/main.js")],
    {
      cwd: join(runtime, "server"),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PAWS_WEB_ROOT: join(runtime, "web"),
        PATH: `${runtime}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );
  backend = child;
  child.on("exit", () => {
    if (started && !stopping) {
      dialog.showErrorBox(
        "Paws stopped",
        "The local server stopped. Restart Paws to reconnect.",
      );
      app.quit();
    }
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Server startup timed out.")),
      30000,
    );
    const finish = () => clearTimeout(timeout);
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("exit", () => {
      finish();
      reject(
        new Error(
          "Server startup failed. Check whether port 4310 is already in use.",
        ),
      );
    });
    child.on("message", (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "ready"
      ) {
        finish();
        resolve(undefined);
      }
    });
  });
  started = true;
}

function openWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Paws",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
    }
  });
  void window.loadURL(origin);
}

app.on("before-quit", () => {
  stopping = true;

  if (backend?.connected) backend.disconnect();
});

try {
  if (app.isPackaged) await startBackend();

  openWindow();
} catch (error) {
  dialog.showErrorBox(
    "Unable to start Paws",
    error instanceof Error ? error.message : "Restart Paws and try again.",
  );
  app.quit();
}
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    openWindow();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
