import { type BrowserWindow, type IpcMain, shell } from 'electron';

import {
  type AppPreferences,
  type MinerConfig,
  type MiningStats,
  type MiningStatus,
  type PersistedState,
  minerConfigSchema,
  miningStatusSchema,
} from '../shared/config-schema.ts';
import {
  IpcChannel,
  type MiningStateUpdate,
  isSafeExternalUrl,
  openExternalPayloadSchema,
  setConfigPayloadSchema,
  setPreferencesPayloadSchema,
} from '../shared/ipc.ts';
import type { ConfigStore } from './config-store.ts';
import type { XmrigRunner, XmrigUpdate } from './xmrig-runner.ts';

export class MiningCoordinator {
  private status: MiningStatus = 'idle';
  private stats: MiningStats = emptyStats();
  private lastMessage: string | undefined;

  public constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly runner: XmrigRunner,
  ) {
    runner.onUpdate((update) => this.onRunnerUpdate(update));
  }

  public getStatus(): MiningStatus {
    return this.status;
  }

  public snapshot(): MiningStateUpdate {
    const update: MiningStateUpdate = { status: this.status, stats: { ...this.stats } };
    if (this.lastMessage !== undefined) update.message = this.lastMessage;
    return update;
  }

  public async start(config: MinerConfig): Promise<void> {
    this.lastMessage = undefined;
    // The runner publishes its own 'error' transition through onUpdate when
    // start() rejects, so we don't intercept the failure here — letting it
    // bubble is what makes the renderer's invoke() reject so it can toast.
    // 失敗時に runner が onUpdate 経由で error 状態を流すので、ここでは握り潰さず素通しする。
    await this.runner.start(config);
  }

  public async stop(): Promise<void> {
    await this.runner.stop();
  }

  public resetStats(): void {
    this.runner.resetStats();
  }

  private onRunnerUpdate(update: XmrigUpdate): void {
    this.status = update.status;
    this.stats = { ...update.stats };
    this.lastMessage = update.message;
    this.broadcast(this.snapshot());
  }

  private broadcast(update: MiningStateUpdate): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IpcChannel.StateUpdate, update);
  }
}

function emptyStats(): MiningStats {
  return {
    hashrate: 0,
    acceptedShares: 0,
    rejectedShares: 0,
    totalHashes: 0,
    uptimeSec: 0,
  };
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

  ipcMain.handle(
    IpcChannel.StartMining,
    async (_event, raw: unknown): Promise<MiningStateUpdate> => {
      const config = minerConfigSchema.parse(raw);
      await coordinator.start(config);
      return coordinator.snapshot();
    },
  );

  ipcMain.handle(IpcChannel.StopMining, async (): Promise<MiningStateUpdate> => {
    await coordinator.stop();
    return coordinator.snapshot();
  });

  ipcMain.handle(IpcChannel.ResetStats, (): MiningStateUpdate => {
    coordinator.resetStats();
    return coordinator.snapshot();
  });

  ipcMain.handle(IpcChannel.GetMiningStatus, (): MiningStatus => {
    return miningStatusSchema.parse(coordinator.getStatus());
  });

  ipcMain.handle(IpcChannel.OpenExternal, async (_event, raw: unknown): Promise<void> => {
    const { url } = openExternalPayloadSchema.parse(raw);
    // Defense in depth: schema already filtered, but keep the runtime guard.
    if (!isSafeExternalUrl(url)) {
      throw new Error('external_url_protocol_not_allowed');
    }
    await shell.openExternal(url);
  });

  ipcMain.handle(IpcChannel.AppVersion, (): string => appVersion);
}
