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

  public async start(config: MinerConfig): Promise<string> {
    this.status = 'starting';
    this.broadcast({ status: this.status });
    try {
      // Skip the bundled proxy entirely when the user has supplied an
      // external WebSocket override. The documented override path is meant
      // to be independent: bind failures on the loopback proxy must not
      // abort a session that never planned to use it.
      // 外部 WebSocket リレーが指定されている場合は同梱プロキシを起動しない。
      // ローカル bind 失敗で外部リレー利用までブロックされないようにする。
      if (config.webSocket !== '') {
        return config.webSocket;
      }
      return await this.proxy.start();
    } catch (cause) {
      // Without this, the renderer stays stuck on 'starting' forever when
      // proxy.start() rejects — the user has no signal that anything failed
      // until they manually press Stop.
      // ここで失敗を反映しないと UI が starting のまま固まる。
      const message = cause instanceof Error ? cause.message : String(cause);
      this.status = 'error';
      this.broadcast({ status: 'error', message });
      throw cause;
    }
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
