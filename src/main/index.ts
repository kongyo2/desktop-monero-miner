import { BrowserWindow, app, ipcMain, session } from 'electron';

import { ConfigStore } from './config-store.ts';
import { MiningCoordinator, registerIpcHandlers } from './ipc-handlers.ts';
import { createMainWindow } from './window.ts';

let mainWindow: BrowserWindow | null = null;

function applyContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' https://cdn.jsdelivr.net wss: https:",
      "worker-src 'self' blob:",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

function bootstrap(): void {
  const store = new ConfigStore();
  const coordinator = new MiningCoordinator(() => mainWindow);
  registerIpcHandlers(ipcMain, store, coordinator, app.getVersion());

  applyContentSecurityPolicy();

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
