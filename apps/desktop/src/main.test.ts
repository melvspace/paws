import { expect, test, vi } from "vite-plus/test";

const electron = vi.hoisted(() => {
  let ready = () => {};
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });

  return {
    ready,
    app: {
      isPackaged: false,
      requestSingleInstanceLock: vi.fn(() => true),
      whenReady: vi.fn(() => readiness),
      on: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
    },
    BrowserWindow: vi.fn(function () {
      return {
        webContents: {
          setWindowOpenHandler: vi.fn(),
          on: vi.fn(),
        },
        loadURL: vi.fn(),
      };
    }),
    dialog: { showErrorBox: vi.fn() },
  };
});

vi.mock("electron", () => electron);

test("main module finishes loading before Electron becomes ready", async () => {
  let loaded = false;
  const loading = import("./main.mjs").then(() => {
    loaded = true;
  });

  try {
    await vi.waitFor(() => expect(loaded).toBe(true), { timeout: 1000 });
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
  } finally {
    electron.ready();
    await loading;
  }

  await vi.waitFor(() => {
    expect(electron.BrowserWindow).toHaveBeenCalledOnce();
  });
});
