import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

import { isSafeExternalUrl } from '../shared/ipc.ts';

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#0e1116',
    title: 'Desktop Monero Miner',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.setMenuBarVisibility(false);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      console.warn('[window] blocked openExternal for disallowed URL:', url);
    }
    return { action: 'deny' };
  });

  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}
