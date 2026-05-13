import { BrowserWindow, app, ipcMain } from 'electron';

import { ConfigStore } from './config-store.ts';
import { MiningCoordinator, registerIpcHandlers } from './ipc-handlers.ts';
import { createMainWindow } from './window.ts';

let mainWindow: BrowserWindow | null = null;

// The Content-Security-Policy is declared in src/renderer/index.html via a
// <meta http-equiv="Content-Security-Policy"> tag. Electron's
// `webRequest.onHeadersReceived` does not apply to `file://` resources, so the
// policy must accompany the document. See src/renderer/index.html for the
// active policy.
// CSP は src/renderer/index.html の <meta> タグで宣言します。
// Electron の webRequest フックは file:// に効かないため、ドキュメント側で持つ必要があります。

function bootstrap(): void {
  const store = new ConfigStore();
  const coordinator = new MiningCoordinator(() => mainWindow);
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

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const url = new URL(navigationUrl);
    if (url.protocol !== 'file:') event.preventDefault();
  });
});
