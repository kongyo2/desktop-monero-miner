import type { MinerConfig, MiningStats, MiningStatus } from '../shared/config-schema.ts';
import type { MiningStateUpdate } from '../shared/ipc.ts';

import './webminer.d.ts';

/**
 * Pinned to an immutable commit so shipped builds are reproducible and not
 * exposed to silent upstream changes. To upgrade, update both the commit SHA
 * and the SRI hash together.
 * 不変リビジョンに固定し、再現性を確保しつつ上流の差し替えに影響されないようにします。
 * 更新時はコミット SHA と SRI ハッシュを同時に更新してください。
 */
const MINER_SCRIPT_COMMIT = 'e0bd235';
const MINER_SCRIPT_URL = `https://cdn.jsdelivr.net/gh/NajmAjmal/monero-webminer@${MINER_SCRIPT_COMMIT}/script.js`;
const MINER_SCRIPT_INTEGRITY =
  'sha384-Hg5SuYBtgmKrjjlPFlVTWp3Ehka9Bvt3+oKaqCnJYVbBnzvxca42baUJ4M/nXI/8';

export type MinerEvents = {
  onUpdate: (update: MiningStateUpdate) => void;
};

export class WebMiner {
  private scriptPromise: Promise<void> | null = null;
  private status: MiningStatus = 'idle';
  private statsInterval: number | null = null;
  private startedAt: number | null = null;
  /**
   * Monotonically increasing generation token. Every `start()` captures the
   * current value, and every `stop()` increments it; an in-flight `start()`
   * that finds its captured value stale aborts before invoking `startMining`.
   * 各 start 呼び出しが世代番号を取得し、stop が世代をインクリメントすることで
   * 競合する未完了の start を確実にキャンセルします。
   */
  private startGeneration = 0;
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
    const generation = ++this.startGeneration;
    this.transition({ status: 'starting' });

    try {
      await this.loadScript();
      if (generation !== this.startGeneration) {
        // stop() was called while we were awaiting; do not start mining.
        return;
      }
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
      if (generation !== this.startGeneration) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.transition({ status: 'error', message });
      throw cause;
    }
  }

  public stop(): void {
    // Always bump the generation so any in-flight start() sees a stale token
    // and aborts before invoking the underlying miner.
    this.startGeneration += 1;
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
    const promise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[data-miner="webminer"]`);
      if (existing) {
        if (existing.dataset['loaded'] === 'true') {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener(
          'error',
          () => {
            // Drop the broken tag so the next attempt can re-insert a fresh one.
            existing.remove();
            reject(new Error('Failed to load miner script'));
          },
          { once: true },
        );
        return;
      }
      const tag = document.createElement('script');
      tag.src = MINER_SCRIPT_URL;
      tag.integrity = MINER_SCRIPT_INTEGRITY;
      tag.crossOrigin = 'anonymous';
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
      tag.addEventListener(
        'error',
        () => {
          tag.remove();
          reject(new Error('Failed to load miner script'));
        },
        { once: true },
      );
      document.head.appendChild(tag);
    });
    // Clear the cached promise on failure so callers can retry after a transient error.
    promise.catch(() => {
      if (this.scriptPromise === promise) {
        this.scriptPromise = null;
      }
    });
    this.scriptPromise = promise;
    return promise;
  }

  private beginStatsLoop(): void {
    this.endStatsLoop();
    this.statsInterval = window.setInterval(() => {
      const hashrate = safeNumber(globalThis.getHashesPerSecond?.());
      const totalHashes = safeNumber(globalThis.getTotalHashes?.());
      const accepted = safeNumber(globalThis.getAcceptedHashes?.());
      // Some miner script builds expose a rejected counter; fall back to 0 when absent
      // rather than freezing a stale value from the previous tick.
      const rejected = safeNumber(globalThis.getRejectedHashes?.());
      const uptimeSec =
        this.startedAt === null ? 0 : Math.floor((performance.now() - this.startedAt) / 1000);
      this.latestStats = {
        hashrate,
        acceptedShares: accepted,
        rejectedShares: rejected,
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
