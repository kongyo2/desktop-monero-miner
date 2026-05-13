import { BrowserWindow, app, ipcMain } from 'electron';
import { join } from 'node:path';

import { ConfigStore } from './config-store.ts';
import { MiningCoordinator, registerIpcHandlers } from './ipc-handlers.ts';
import { createMainWindow } from './window.ts';
import { XmrigRunner } from './xmrig-runner.ts';

let mainWindow: BrowserWindow | null = null;
let runner: XmrigRunner | null = null;

// The Content-Security-Policy is declared in src/renderer/index.html via a
// <meta http-equiv="Content-Security-Policy"> tag. Electron's
// `webRequest.onHeadersReceived` does not apply to `file://` resources, so the
// policy must accompany the document. See src/renderer/index.html for the
// active policy.
// CSP は src/renderer/index.html の <meta> タグで宣言します。
// Electron の webRequest フックは file:// に効かないため、ドキュメント側で持つ必要があります。

function bootstrap(): void {
  const store = new ConfigStore();
  const cacheDir = join(app.getPath('userData'), 'xmrig');
  runner = new XmrigRunner({
    cacheDir,
    onInstallProgress: (phase, detail) => {
      console.log(`[xmrig-install] ${phase}: ${detail}`);
    },
  });
  const coordinator = new MiningCoordinator(() => mainWindow, runner);
  registerIpcHandlers(ipcMain, store, coordinator, app.getVersion());

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
  if (!runner) return;
  const current = runner;
  runner = null;
  // Hold the quit until xmrig terminates; without this Electron exits while
  // the child still owns CPU threads, leaving an orphaned miner process the
  // user has to find and kill manually.
  // xmrig の終了を待ってからアプリを落とす。さもないと採掘プロセスが孤児になる。
  event.preventDefault();
  void current
    .stop()
    .catch((err) => {
      console.warn('[main] xmrig runner stop failed:', err);
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
