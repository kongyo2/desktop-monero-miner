import type { MinerConfig, MiningStats, MiningStatus } from '../shared/config-schema.ts';
import type { MiningStateUpdate } from '../shared/ipc.ts';

import './webminer.d.ts';

const MINER_SCRIPT_URL = 'https://cdn.jsdelivr.net/gh/NajmAjmal/monero-webminer@main/script.js';

export type MinerEvents = {
  onUpdate: (update: MiningStateUpdate) => void;
};

export class WebMiner {
  private scriptPromise: Promise<void> | null = null;
  private status: MiningStatus = 'idle';
  private statsInterval: number | null = null;
  private startedAt: number | null = null;
  private latestStats: MiningStats = {
    hashrate: 0,
    acceptedShares: 0,
    rejectedShares: 0,
    totalHashes: 0,
    uptimeSec: 0,
  };

  public constructor(private readonly events: MinerEvents) {}

  public getStatus(): MiningStatus {
    return this.status;
  }

  public getStats(): MiningStats {
    return { ...this.latestStats };
  }

  public async start(config: MinerConfig): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return;
    this.transition({ status: 'starting' });

    try {
      await this.loadScript();
      this.applyGlobals(config);
      const start = globalThis.startMining;
      if (typeof start !== 'function') {
        throw new Error('startMining function not exposed by miner script.');
      }
      start(config.pool, config.walletAddress, config.workerId, config.threads, config.password);
      this.startedAt = performance.now();
      this.beginStatsLoop();
      this.transition({ status: 'running' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.transition({ status: 'error', message });
      throw cause;
    }
  }

  public stop(): void {
    if (this.status === 'idle' || this.status === 'stopping') return;
    this.transition({ status: 'stopping' });

    const stop = globalThis.stopMining;
    if (typeof stop === 'function') {
      try {
        stop();
      } catch (cause) {
        console.warn('[miner] stopMining threw:', cause);
      }
    }
    this.endStatsLoop();
    this.startedAt = null;
    this.latestStats = {
      hashrate: 0,
      acceptedShares: this.latestStats.acceptedShares,
      rejectedShares: this.latestStats.rejectedShares,
      totalHashes: this.latestStats.totalHashes,
      uptimeSec: 0,
    };
    this.transition({ status: 'idle' });
  }

  public resetStats(): void {
    this.latestStats = {
      hashrate: 0,
      acceptedShares: 0,
      rejectedShares: 0,
      totalHashes: 0,
      uptimeSec: 0,
    };
    this.events.onUpdate({ status: this.status, stats: this.getStats() });
  }

  private applyGlobals(config: MinerConfig): void {
    globalThis.server = config.webSocket;
    globalThis.throttleMiner = config.throttle;
    globalThis.workerId = config.workerId;
    globalThis.threads = config.threads;
    globalThis.password = config.password;
    globalThis.walletAddress = config.walletAddress;
    globalThis.pool = config.pool;
  }

  private loadScript(): Promise<void> {
    if (this.scriptPromise) return this.scriptPromise;
    this.scriptPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[data-miner="webminer"]`);
      if (existing) {
        if (existing.dataset['loaded'] === 'true') {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load miner script')), {
          once: true,
        });
        return;
      }
      const tag = document.createElement('script');
      tag.src = MINER_SCRIPT_URL;
      tag.defer = true;
      tag.dataset['miner'] = 'webminer';
      tag.addEventListener(
        'load',
        () => {
          tag.dataset['loaded'] = 'true';
          resolve();
        },
        { once: true },
      );
      tag.addEventListener('error', () => reject(new Error('Failed to load miner script')), {
        once: true,
      });
      document.head.appendChild(tag);
    });
    return this.scriptPromise;
  }

  private beginStatsLoop(): void {
    this.endStatsLoop();
    this.statsInterval = window.setInterval(() => {
      const hashrate = safeNumber(globalThis.getHashesPerSecond?.());
      const totalHashes = safeNumber(globalThis.getTotalHashes?.());
      const accepted = safeNumber(globalThis.getAcceptedHashes?.());
      const uptimeSec =
        this.startedAt === null ? 0 : Math.floor((performance.now() - this.startedAt) / 1000);
      this.latestStats = {
        hashrate,
        acceptedShares: accepted,
        rejectedShares: this.latestStats.rejectedShares,
        totalHashes,
        uptimeSec,
      };
      this.events.onUpdate({ status: this.status, stats: this.getStats() });
    }, 1000);
  }

  private endStatsLoop(): void {
    if (this.statsInterval !== null) {
      window.clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  private transition(update: MiningStateUpdate): void {
    this.status = update.status;
    this.events.onUpdate({ ...update, stats: this.getStats() });
  }
}

function safeNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return 0;
}
