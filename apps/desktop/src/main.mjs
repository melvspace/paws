import { app, BrowserWindow } from "electron";

await app.whenReady();

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
    if (new URL(url).origin !== "http://localhost:5173") {
      event.preventDefault();
    }
  });
  void window.loadURL("http://localhost:5173");
}

openWindow();
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
