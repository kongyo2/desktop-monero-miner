import type { MinerBridge } from '../preload/index.ts';

declare global {
  interface Window {
    miner: MinerBridge;
  }
}

export {};
