import { type BrowserWindow, type IpcMain, shell } from 'electron';

import {
  type AppPreferences,
  type MinerConfig,
  type MiningStatus,
  type PersistedState,
  minerConfigSchema,
  miningStatusSchema,
} from '../shared/config-schema.ts';
import {
  IpcChannel,
  type MiningStateUpdate,
  miningStateUpdateSchema,
  openExternalPayloadSchema,
  setConfigPayloadSchema,
  setPreferencesPayloadSchema,
} from '../shared/ipc.ts';
import type { ConfigStore } from './config-store.ts';

export class MiningCoordinator {
  private status: MiningStatus = 'idle';

  public constructor(private readonly getWindow: () => BrowserWindow | null) {}

  public getStatus(): MiningStatus {
    return this.status;
  }

  public start(_config: MinerConfig): void {
    this.status = 'starting';
    this.broadcast({ status: this.status });
  }

  public stop(): void {
    this.status = 'stopping';
    this.broadcast({ status: this.status });
  }

  public onRendererUpdate(update: MiningStateUpdate): void {
    this.status = update.status;
    this.broadcast(update);
  }

  private broadcast(update: MiningStateUpdate): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IpcChannel.ReportStats, update);
  }
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  store: ConfigStore,
  coordinator: MiningCoordinator,
  appVersion: string,
): void {
  ipcMain.handle(IpcChannel.GetConfig, (): PersistedState['config'] => {
    return store.getConfig();
  });

  ipcMain.handle(IpcChannel.SetConfig, (_event, raw: unknown): PersistedState['config'] => {
    const { patch } = setConfigPayloadSchema.parse(raw);
    return store.updateConfig(patch);
  });

  ipcMain.handle(IpcChannel.GetPreferences, (): AppPreferences => {
    return store.getPreferences();
  });

  ipcMain.handle(IpcChannel.SetPreferences, (_event, raw: unknown): AppPreferences => {
    const { patch } = setPreferencesPayloadSchema.parse(raw);
    return store.updatePreferences(patch);
  });

  ipcMain.handle(IpcChannel.StartMining, (_event, raw: unknown): MiningStatus => {
    const config = minerConfigSchema.parse(raw);
    coordinator.start(config);
    return coordinator.getStatus();
  });

  ipcMain.handle(IpcChannel.StopMining, (): MiningStatus => {
    coordinator.stop();
    return coordinator.getStatus();
  });

  ipcMain.handle(IpcChannel.GetMiningStatus, (): MiningStatus => {
    return miningStatusSchema.parse(coordinator.getStatus());
  });

  ipcMain.on(IpcChannel.ReportStats, (_event, raw: unknown): void => {
    const update = miningStateUpdateSchema.parse(raw);
    coordinator.onRendererUpdate(update);
  });

  ipcMain.handle(IpcChannel.OpenExternal, async (_event, raw: unknown): Promise<void> => {
    const { url } = openExternalPayloadSchema.parse(raw);
    await shell.openExternal(url);
  });

  ipcMain.handle(IpcChannel.AppVersion, (): string => appVersion);
}
