import { app, BrowserWindow, dialog } from "electron";
import { runtimeSetupRequest } from "./runtimeSetup.mjs";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";

/** @type {import("node:child_process").ChildProcess | undefined} */
let backend;
let stopping = false;
const origin = app.isPackaged
  ? "http://127.0.0.1:4310"
  : "http://localhost:5173";

if (!app.requestSingleInstanceLock()) app.exit();

async function startBackend() {
  let started = false;
  let startupFailure = "The local server stopped before startup finished.";
  const runtime = join(process.resourcesPath, "runtime");
  const child = spawn(
    join(runtime, process.platform === "win32" ? "node.exe" : "node"),
    [join(runtime, "server/src/main.js")],
    {
      cwd: join(runtime, "server"),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PAWS_DESKTOP: "1",
        PAWS_RUNTIME_ASSETS: join(runtime, "containers"),
        PAWS_WEB_ROOT: join(runtime, "web"),
        PATH: `${join(runtime, "containers", "bin")}${process.platform === "win32" ? ";" : ":"}${runtime}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
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
      20 * 60_000,
    );
    const finish = () => clearTimeout(timeout);
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("exit", () => {
      finish();
      reject(new Error(startupFailure));
    });
    let authorizing = false;
    child.on("message", (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "startup-error" &&
        "message" in message &&
        typeof message.message === "string"
      )
        startupFailure = message.message.slice(0, 4096);

      const request = runtimeSetupRequest(
        message,
        process.env.PAWS_HOME ?? join(homedir(), ".paws"),
      );

      if (request && !authorizing) {
        authorizing = true;
        void (async () => {
          let ok = false;

          try {
            const answer = await dialog.showMessageBox({
              type: "question",
              title: "Finish setting up Paws",
              message: "Paws needs system permission to enable its sandbox.",
              detail:
                "This setup runs once before chat opens. Paws runs without administrator access afterward.",
              buttons: ["Set up Paws", "Quit"],
              defaultId: 0,
              cancelId: 1,
            });

            if (answer.response === 0) {
              await new Promise((resolve, reject) => {
                execFile(
                  "pkexec",
                  [request.helper, request.binary],
                  {
                    timeout: 300_000,
                    maxBuffer: 1024 * 1024,
                  },
                  (error) => (error ? reject(error) : resolve(undefined)),
                );
              });
              ok = true;
            }
          } catch {
            // The backend reports setup failure and does not open chat.
          }

          if (child.connected)
            child.send({ type: "runtime-setup-finished", id: request.id, ok });
        })();
      }

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

async function start() {
  await app.whenReady();

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

void start();
