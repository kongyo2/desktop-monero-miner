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
  isSafeExternalUrl,
  miningStateUpdateSchema,
  openExternalPayloadSchema,
  setConfigPayloadSchema,
  setPreferencesPayloadSchema,
} from '../shared/ipc.ts';
import type { ConfigStore } from './config-store.ts';
import type { StratumProxy } from './stratum-proxy.ts';

export class MiningCoordinator {
  private status: MiningStatus = 'idle';

  public constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly proxy: StratumProxy,
  ) {}

  public getStatus(): MiningStatus {
    return this.status;
  }

  public async start(_config: MinerConfig): Promise<string> {
    this.status = 'starting';
    this.broadcast({ status: this.status });
    // Ensure the bundled proxy is up before the renderer attempts to connect;
    // every successful start hands the renderer a fresh, validated address.
    // renderer が接続を試みる前に同梱プロキシを必ず起動し、有効な URL を返す。
    const address = await this.proxy.start();
    return address;
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
  proxy: StratumProxy,
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
    async (_event, raw: unknown): Promise<{ status: MiningStatus; webSocket: string }> => {
      const config = minerConfigSchema.parse(raw);
      const address = await coordinator.start(config);
      return { status: coordinator.getStatus(), webSocket: address };
    },
  );

  ipcMain.handle(IpcChannel.StopMining, (): MiningStatus => {
    coordinator.stop();
    return coordinator.getStatus();
  });

  ipcMain.handle(IpcChannel.GetMiningStatus, (): MiningStatus => {
    return miningStatusSchema.parse(coordinator.getStatus());
  });

  ipcMain.on(IpcChannel.ReportStats, (_event, raw: unknown): void => {
    // Fire-and-forget event — never throw out of the handler.
    const parsed = miningStateUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[ipc] ignoring malformed ReportStats payload:', parsed.error.message);
      return;
    }
    coordinator.onRendererUpdate(parsed.data);
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

  ipcMain.handle(IpcChannel.ProxyAddress, async (): Promise<string> => {
    // Boot the proxy lazily on first request; subsequent calls reuse it.
    // 最初の呼び出しで起動し、以降は同じインスタンスを返す。
    return proxy.start();
  });
}
