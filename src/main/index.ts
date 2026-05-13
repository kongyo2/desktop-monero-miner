import { BrowserWindow, app, ipcMain } from 'electron';

import { ConfigStore } from './config-store.ts';
import { MiningCoordinator, registerIpcHandlers } from './ipc-handlers.ts';
import { StratumProxy } from './stratum-proxy.ts';
import { createMainWindow } from './window.ts';

let mainWindow: BrowserWindow | null = null;
let proxy: StratumProxy | null = null;

// The Content-Security-Policy is declared in src/renderer/index.html via a
// <meta http-equiv="Content-Security-Policy"> tag. Electron's
// `webRequest.onHeadersReceived` does not apply to `file://` resources, so the
// policy must accompany the document. See src/renderer/index.html for the
// active policy.
// CSP は src/renderer/index.html の <meta> タグで宣言します。
// Electron の webRequest フックは file:// に効かないため、ドキュメント側で持つ必要があります。

function bootstrap(): void {
  const store = new ConfigStore();
  proxy = new StratumProxy();
  const coordinator = new MiningCoordinator(() => mainWindow, proxy);
  registerIpcHandlers(ipcMain, store, coordinator, app.getVersion(), proxy);

  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

void app.whenReady().then(() => {
  bootstrap();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', (event) => {
  if (!proxy) return;
  const current = proxy;
  proxy = null;
  // Hold the quit until the proxy releases its TCP listeners; otherwise the
  // OS may keep the loopback port wedged after the app exits, blocking the
  // next launch on the same port.
  // ループバックのリスナー解放を待ってから終了。残ったままだと次回起動時に
  // ポートが掴まれて起動に失敗することがある。
  event.preventDefault();
  void current
    .stop()
    .catch((err) => {
      console.warn('[main] stratum proxy stop failed:', err);
    })
    .finally(() => {
      app.exit(0);
    });
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const url = new URL(navigationUrl);
    if (url.protocol !== 'file:') event.preventDefault();
  });
});
