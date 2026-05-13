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
  /**
   * Cumulative miner-script counters at the most recent reset point. Every
   * stats-loop tick subtracts these from the current globals so the displayed
   * values are deltas since the last reset (or start), not absolute totals.
   * 直近のリセット時点における累積カウンタ。表示値は「現在値 - これらのオフセット」
   * とすることで、Reset ボタン押下後に次の tick で値が戻ってしまうのを防ぎます。
   */
  private resetOffsets: {
    totalHashes: number;
    acceptedShares: number;
    rejectedShares: number;
  } = {
    totalHashes: 0,
    acceptedShares: 0,
    rejectedShares: 0,
  };
  /**
   * Previous tick snapshot used to derive instantaneous hashrate from the
   * cumulative `totalhashes` global exposed by the miner script.
   * 前回 tick のスナップショット。スクリプトが累積カウンタ totalhashes しか
   * 公開していないため、その差分から瞬間ハッシュレートを算出する。
   */
  private prevSample: { totalHashes: number; timeMs: number } | null = null;
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
      if (globalThis.wasmSupported === false) {
        throw new Error('WebAssembly is required but not available in this runtime.');
      }
      // Argument order is fixed by the upstream miner script:
      //   startMining(pool, login, password, threads, userid)
      // login = wallet address, userid = worker ID. Passing them in any other
      // order causes the pool to see the worker ID as the password (or vice
      // versa) and breaks dashboards.
      // 上流スクリプトの引数順は (pool, login, password, threads, userid) で固定。
      // login がウォレット、userid がワーカー ID。順序を取り違えるとプール側で
      // ワーカー ID とパスワードが入れ替わり、ダッシュボードが壊れる。
      start(config.pool, config.walletAddress, config.password, config.threads, config.workerId);
      this.startedAt = performance.now();
      // Capture the current cumulative counters as the new baseline so a fresh
      // session starts from zero even if the underlying miner script keeps
      // counters across stop/start cycles.
      // 新規セッション開始時点の累積値をベースラインに記録し、
      // ミナースクリプトが counters を持ち越しても表示は 0 から開始する。
      this.captureResetOffsets();
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
    this.prevSample = null;
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
    // Re-baseline against the current cumulative miner counters so subsequent
    // ticks display deltas from "now" rather than bouncing back to old totals.
    // 累積カウンタを基準点として再設定し、次の tick で旧累積値に戻らないようにする。
    this.captureResetOffsets();
    if (this.startedAt !== null) {
      this.startedAt = performance.now();
    }
    this.latestStats = {
      hashrate: 0,
      acceptedShares: 0,
      rejectedShares: 0,
      totalHashes: 0,
      uptimeSec: 0,
    };
    this.events.onUpdate({ status: this.status, stats: this.getStats() });
  }

  private captureResetOffsets(): void {
    const submitted = arrayLength(globalThis.sendStack);
    const rejected = countRejectedShares(globalThis.receiveStack);
    this.resetOffsets = {
      totalHashes: safeNumber(globalThis.totalhashes),
      acceptedShares: Math.max(0, submitted - rejected),
      rejectedShares: rejected,
    };
    // Reset the hashrate baseline so the first tick after a reset doesn't
    // report a huge spike based on pre-reset accumulation.
    // リセット直後の tick が古い累積を引きずって瞬間値を跳ね上げないよう、
    // 計測基準を作り直す。
    this.prevSample = {
      totalHashes: safeNumber(globalThis.totalhashes),
      timeMs: performance.now(),
    };
  }

  private applyGlobals(config: MinerConfig): void {
    // The upstream script only reads `server` and `throttleMiner` from globals;
    // everything else is passed positionally into startMining(). Setting the
    // other slots is harmless noise, so we keep this minimal.
    // 上流スクリプトがグローバルから読むのは server と throttleMiner のみで、
    // 他の値は startMining() に位置引数で渡される。設定はこの 2 つに限定する。
    globalThis.server = config.webSocket;
    globalThis.throttleMiner = config.throttle;
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
    // Seed the previous sample so the first tick (~1s later) has a non-zero
    // baseline to subtract from, yielding a real hashrate immediately rather
    // than starting at 0.
    // 1 秒後の最初の tick で瞬間ハッシュレートが 0 にならないよう、開始時点の
    // スナップショットを記録しておく。
    this.prevSample = {
      totalHashes: safeNumber(globalThis.totalhashes),
      timeMs: performance.now(),
    };
    this.statsInterval = window.setInterval(() => {
      const now = performance.now();
      const totalCumulative = safeNumber(globalThis.totalhashes);
      const totalHashes = Math.max(0, totalCumulative - this.resetOffsets.totalHashes);

      // Hashrate is derived from the delta of the cumulative counter over the
      // wall-clock interval since the previous tick. The upstream miner script
      // does not expose an instantaneous rate getter, and ticks may slip if the
      // event loop is busy, so we cannot assume a fixed 1s window.
      // 上流スクリプトに瞬間レートのゲッタは存在しないため、累積差分を実経過時間
      // で割って算出する。tick の間隔は厳密に 1 秒とは限らない。
      let hashrate = 0;
      if (this.prevSample !== null) {
        const dt = (now - this.prevSample.timeMs) / 1000;
        const dh = totalCumulative - this.prevSample.totalHashes;
        if (dt > 0 && dh >= 0) hashrate = dh / dt;
      }
      this.prevSample = { totalHashes: totalCumulative, timeMs: now };

      const submitted = arrayLength(globalThis.sendStack);
      const rejectedTotal = countRejectedShares(globalThis.receiveStack);
      // sendStack tracks every share posted to the proxy. Pools effectively
      // never reject shares we already validated client-side against the job
      // target, so "submitted minus observed rejections" is a sound proxy for
      // accepted-by-pool. If the proxy/pool surfaces explicit rejection
      // messages, countRejectedShares() will pull them out of receiveStack.
      // sendStack はプロキシへ提出した全シェア、receiveStack に拒否通知があれば
      // それを差し引いた値を「承認シェア」とみなす。
      const acceptedShares = Math.max(
        0,
        submitted - rejectedTotal - this.resetOffsets.acceptedShares,
      );
      const rejectedShares = Math.max(0, rejectedTotal - this.resetOffsets.rejectedShares);

      const uptimeSec = this.startedAt === null ? 0 : Math.floor((now - this.startedAt) / 1000);
      this.latestStats = {
        hashrate,
        acceptedShares,
        rejectedShares,
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

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Pool responses queued in `receiveStack` by the upstream script. Different
 * proxies/pools surface rejection differently — most commonly via an `error`
 * field or an `identifier`/`status` value containing "reject". We accept any of
 * those signals to avoid undercounting.
 * 上流スクリプトが pool/proxy から受信したメッセージを receiveStack に積む。
 * 拒否通知の形式は実装依存のため、error フィールドや identifier/status に
 * "reject" を含むものを幅広く拒否シェアとして数える。
 */
function countRejectedShares(stack: unknown): number {
  if (!Array.isArray(stack)) return 0;
  let count = 0;
  for (const item of stack) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj['error'] !== undefined && obj['error'] !== null) {
      count += 1;
      continue;
    }
    const identifier = obj['identifier'];
    if (typeof identifier === 'string' && identifier.toLowerCase().includes('reject')) {
      count += 1;
      continue;
    }
    const status = obj['status'];
    if (typeof status === 'string' && status.toLowerCase().includes('reject')) {
      count += 1;
    }
  }
  return count;
}
