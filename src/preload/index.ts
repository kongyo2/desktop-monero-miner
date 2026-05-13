import { contextBridge, ipcRenderer } from 'electron';

import {
  type AppPreferences,
  type MinerConfig,
  type MiningStatus,
  type PartialMinerConfig,
  type PersistedState,
} from '../shared/config-schema.ts';
import { IpcChannel, type MiningStateUpdate } from '../shared/ipc.ts';

export type MinerBridge = {
  getConfig: () => Promise<PersistedState['config']>;
  setConfig: (patch: PartialMinerConfig) => Promise<PersistedState['config']>;
  getPreferences: () => Promise<AppPreferences>;
  setPreferences: (patch: Partial<AppPreferences>) => Promise<AppPreferences>;
  startMining: (config: MinerConfig) => Promise<MiningStateUpdate>;
  stopMining: () => Promise<MiningStateUpdate>;
  resetStats: () => Promise<MiningStateUpdate>;
  getMiningStatus: () => Promise<MiningStatus>;
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
  resetStats: () => ipcRenderer.invoke(IpcChannel.ResetStats),
  getMiningStatus: () => ipcRenderer.invoke(IpcChannel.GetMiningStatus),
  onStateUpdate: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      handler(payload as MiningStateUpdate);
    };
    ipcRenderer.on(IpcChannel.StateUpdate, listener);
    return () => {
      ipcRenderer.removeListener(IpcChannel.StateUpdate, listener);
    };
  },
  openExternal: (url) => ipcRenderer.invoke(IpcChannel.OpenExternal, { url }),
  appVersion: () => ipcRenderer.invoke(IpcChannel.AppVersion),
};

contextBridge.exposeInMainWorld('miner', bridge);
