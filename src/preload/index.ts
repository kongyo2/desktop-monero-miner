import { contextBridge, ipcRenderer } from 'electron';

import {
  type AppPreferences,
  type MinerConfig,
  type MiningStatus,
  type PartialMinerConfig,
  type PersistedState,
} from '../shared/config-schema.ts';
import { IpcChannel, type MiningStateUpdate } from '../shared/ipc.ts';

export type StartMiningResult = {
  status: MiningStatus;
  webSocket: string;
};

export type MinerBridge = {
  getConfig: () => Promise<PersistedState['config']>;
  setConfig: (patch: PartialMinerConfig) => Promise<PersistedState['config']>;
  getPreferences: () => Promise<AppPreferences>;
  setPreferences: (patch: Partial<AppPreferences>) => Promise<AppPreferences>;
  startMining: (config: MinerConfig) => Promise<StartMiningResult>;
  stopMining: () => Promise<MiningStatus>;
  getMiningStatus: () => Promise<MiningStatus>;
  getProxyAddress: () => Promise<string>;
  reportStats: (update: MiningStateUpdate) => void;
  onStateUpdate: (handler: (update: MiningStateUpdate) => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  appVersion: () => Promise<string>;
};

const bridge: MinerBridge = {
  getConfig: () => ipcRenderer.invoke(IpcChannel.GetConfig),
  setConfig: (patch) => ipcRenderer.invoke(IpcChannel.SetConfig, { patch }),
  getPreferences: () => ipcRenderer.invoke(IpcChannel.GetPreferences),
  setPreferences: (patch) => ipcRenderer.invoke(IpcChannel.SetPreferences, { patch }),
  startMining: (config) => ipcRenderer.invoke(IpcChannel.StartMining, config),
  stopMining: () => ipcRenderer.invoke(IpcChannel.StopMining),
  getMiningStatus: () => ipcRenderer.invoke(IpcChannel.GetMiningStatus),
  getProxyAddress: () => ipcRenderer.invoke(IpcChannel.ProxyAddress),
  reportStats: (update) => {
    ipcRenderer.send(IpcChannel.ReportStats, update);
  },
  onStateUpdate: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      handler(payload as MiningStateUpdate);
    };
    ipcRenderer.on(IpcChannel.ReportStats, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannel.ReportStats, listener);
    };
  },
  openExternal: (url) => ipcRenderer.invoke(IpcChannel.OpenExternal, { url }),
  appVersion: () => ipcRenderer.invoke(IpcChannel.AppVersion),
};

contextBridge.exposeInMainWorld('miner', bridge);
