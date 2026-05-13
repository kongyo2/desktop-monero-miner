import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MinerConfig, MiningStats } from '../shared/config-schema.ts';
import { ensureXmrigBinary, findXmrigOnPath } from './xmrig-installer.ts';

/**
 * Runs the xmrig binary as a subprocess and surfaces its live stats over
 * IPC. Replaces the previous browser-side CryptoNight web miner which could
 * not mine modern Monero (RandomX) jobs. xmrig is the de facto reference miner
 * for XMR — it speaks Stratum natively, handles TLS, and exposes a small JSON
 * HTTP API for hashrate and share counters that this runner polls each second.
 * xmrig をサブプロセスで実行し、JSON HTTP API から stats を取得する。
 * Renderer 側の web miner（CryptoNight 系）は RandomX を計算できず実用にならない。
 */

const POLL_INTERVAL_MS = 1_000;
/**
 * Hard cap on each /summary request so a wedged xmrig (socket accepted but
 * never replies) cannot accumulate in-flight fetches every second. The poll
 * fires at 1s intervals, so any cap below that bounds outstanding requests
 * to at most one per tick — a brief 800ms is plenty for a loopback API.
 * 1 リクエストあたりの上限。これが無いと毎秒の poll が滞留して累積する。
 */
const POLL_TIMEOUT_MS = 800;
const STOP_TIMEOUT_MS = 5_000;

export type XmrigStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error';

export type XmrigUpdate = {
  status: XmrigStatus;
  stats: MiningStats;
  message?: string;
};

export type XmrigOptions = {
  /**
   * Directory where the auto-installer caches the downloaded xmrig release.
   * The runner only writes here when the binary is not pre-installed via
   * `XMRIG_BIN` or PATH. Required so the runner does not depend on the global
   * `app` module and stays unit-testable.
   * 自動インストール時の展開先。runner を Electron 非依存に保つため呼び出し側から受け取る。
   */
  cacheDir: string;
  /** Optional progress sink for download/verify/extract phases of first-launch install. */
  onInstallProgress?: (phase: 'download' | 'verify' | 'extract', detail: string) => void;
};

type ParsedPool = {
  host: string;
  port: number;
  tls: boolean;
};

type XmrigSummary = {
  uptime?: number;
  hashrate?: {
    total?: Array<number | null>;
  };
  results?: {
    shares_good?: number;
    shares_total?: number;
    hashes_total?: number;
  };
  connection?: {
    error_log?: Array<{ text?: string } | string>;
  };
};

export class XmrigRunner {
  private process: ChildProcess | null = null;
  private apiPort: number | null = null;
  private apiToken: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private status: XmrigStatus = 'idle';
  private startedAt: number | null = null;
  private resetOffsets = { totalHashes: 0, acceptedShares: 0, rejectedShares: 0 };
  private latestStats: MiningStats = emptyStats();
  private listeners = new Set<(update: XmrigUpdate) => void>();
  private generation = 0;
  /**
   * Path to xmrig's per-run log file. xmrig's stdout is intermittently buffered
   * when not attached to a TTY, so we route it via `-l <file>` instead — the
   * file is read on abnormal exit to surface real diagnostic context to the UI.
   * Cleared on stop. xmrig は TTY 以外の stdout への書き出しを取りこぼすことがあるため
   * `-l` でファイルに落とし、異常終了時にそれを読んで UI へエラー文脈を流す。
   */
  private logFilePath: string | null = null;
  private logDirPath: string | null = null;
  /**
   * In-flight stop work. Concurrent callers (e.g. macOS window-all-closed
   * followed by will-quit, or UI Stop pressed during app quit) reuse this
   * promise so they all settle on the same completion — the previous early-
   * return-on-'stopping' branch would otherwise reset state synchronously
   * and let app.exit() fire before the child had actually terminated.
   * 進行中の stop を共有する。多重 stop 呼び出しでも child の実際の終了まで待つ。
   */
  private stopPromise: Promise<void> | null = null;
  /**
   * In-flight start promise plus the AbortController that fans cancellation
   * down into the installer's network/IO work. Without these, a stop() during
   * the install would leave the install path running headlessly; a follow-up
   * start() could then begin a second concurrent install that races on the
   * shared cache directory's extract/rename step and corrupt the xmrig cache.
   * stop() now aborts the in-flight install and awaits the start promise so
   * the next start() begins from a settled state.
   * 進行中 start を tracking。stop() で install を abort し、完全な巻き戻りまで待つ。
   */
  private startPromise: Promise<void> | null = null;
  private installAbort: AbortController | null = null;
  private readonly options: XmrigOptions;

  public constructor(options: XmrigOptions) {
    this.options = options;
  }

  public onUpdate(listener: (update: XmrigUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getStatus(): XmrigStatus {
    return this.status;
  }

  public getStats(): MiningStats {
    return { ...this.latestStats };
  }

  public start(config: MinerConfig): Promise<void> {
    // Concurrent or in-flight start: share the existing promise so two UI
    // clicks (or auto-start + manual start) end up at one mining session.
    // 多重 start は同じ promise を共有して 1 セッションに収束させる。
    if (this.startPromise) return this.startPromise;
    // Only accept Start from a settled state. Allowing it during 'stopping'
    // is a self-terminating race: while the old child is still being torn
    // down, start() would spawn a new child and assign this.process; the
    // stop's final shutdownInternal then captures that fresh process and
    // kills it. Idle and error are both safe — error has no live child.
    // stopping 中の start を許すと in-flight stop が新 child を巻き添えに殺す。
    if (this.status !== 'idle' && this.status !== 'error') return Promise.resolve();

    const installAbort = new AbortController();
    this.installAbort = installAbort;
    this.startPromise = this.runStart(config, installAbort.signal).finally(() => {
      if (this.installAbort === installAbort) this.installAbort = null;
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async runStart(config: MinerConfig, installSignal: AbortSignal): Promise<void> {
    const generation = ++this.generation;
    this.transition('starting');

    try {
      const binary = await this.resolveBinary(installSignal);
      if (generation !== this.generation) return;

      // Re-check generation after every async hop. Without these the second
      // and third awaits act as a "spawn window" that a fast Start→Stop or
      // quit-during-startup can race through, ending up with xmrig launched
      // after the user has already cancelled.
      // 各 await ごとに generation を再チェック。これが無いと「キャンセル後に
      // spawn してしまう」中途半端な状態が起きる。
      const apiPort = await pickFreePort();
      if (generation !== this.generation) return;
      const apiToken = randomBytes(16).toString('hex');
      const logDir = await mkdtemp(join(tmpdir(), 'xmrig-log-'));
      if (generation !== this.generation) {
        await rm(logDir, { recursive: true, force: true }).catch(() => undefined);
        return;
      }
      this.apiPort = apiPort;
      this.apiToken = apiToken;
      const logFile = join(logDir, 'xmrig.log');
      this.logDirPath = logDir;
      this.logFilePath = logFile;
      const args = buildXmrigArgs(config, apiPort, apiToken, logFile);

      // Final cancellation check immediately before the synchronous spawn —
      // anything that happens after this is owned by the child-process exit
      // handler, so a late stop() races through `proc.kill` rather than the
      // "skip spawn entirely" path above.
      // spawn 直前の最終チェック。これより後は exit ハンドラ側で kill して回収する。
      if (generation !== this.generation) return;

      const child = spawn(binary, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env },
      });
      this.process = child;

      child.once('error', (err) => {
        if (this.generation !== generation) return;
        this.shutdownInternal('error', err.message);
      });
      child.once('exit', (code, signal) => {
        if (this.generation !== generation) return;
        if (this.status === 'stopping') {
          this.shutdownInternal('idle');
          return;
        }
        void this.readLogTail().then((tail) => {
          // Re-check the token after the async file read — a user stop()
          // issued while we were tailing the log would otherwise be
          // overwritten by this stale 'error' transition, flipping the UI
          // back from idle to error against the user's intent.
          // log 読み出し中に stop された場合に idle → error へ巻き戻さない。
          if (this.generation !== generation) return;
          const reason = signal
            ? `xmrig terminated by signal ${signal}`
            : `xmrig exited with code ${code ?? 'unknown'}`;
          const message = tail ? `${reason}: ${tail}` : reason;
          this.shutdownInternal('error', message);
        });
      });

      this.startedAt = Date.now();
      this.resetOffsets = { totalHashes: 0, acceptedShares: 0, rejectedShares: 0 };
      this.latestStats = emptyStats();
      this.transition('running');
      this.beginPolling();
    } catch (cause) {
      if (generation !== this.generation) return;
      // Aborted installs surface as DOMException("AbortError"); silence them
      // because the only way to reach this branch with a matching generation
      // is the install's own internal timeout, and emitting a generic error
      // for that case is fine — the message field carries the detail.
      // generation 一致時の AbortError は内部 timeout に相当。message はそのまま。
      const message = cause instanceof Error ? cause.message : String(cause);
      this.shutdownInternal('error', message);
    }
  }

  public stop(): Promise<void> {
    // Concurrent callers share the in-flight stop so they all wait for the
    // same child exit. Without this the second caller's early-return would
    // synchronously reset status to idle and let app.exit() race past the
    // still-alive child, orphaning xmrig after the app process dies.
    // 同時 stop は同じ promise を返し、child の本当の終了まで全員待つ。
    if (this.stopPromise) return this.stopPromise;
    if (this.status === 'idle') return Promise.resolve();
    this.generation += 1;
    // Abort any in-flight install up front so its fetch/pipeline rejects
    // fast. runStop will then await the start promise and we are guaranteed
    // no installer is still running when stop() resolves — a follow-up
    // start() therefore begins from a fully settled state with no
    // concurrent extract/rename race on the shared cache directory.
    // install を先に abort してから start の終了を待つ。これで次の start が
    // 同時 install しないことを保証する。
    if (this.installAbort) {
      this.installAbort.abort(new Error('xmrig install cancelled by stop'));
    }
    this.transition('stopping');
    this.endPolling();
    this.stopPromise = this.runStop();
    return this.stopPromise;
  }

  private async runStop(): Promise<void> {
    try {
      const inflightStart = this.startPromise;
      if (inflightStart) {
        await inflightStart.catch(() => undefined);
      }
      const proc = this.process;
      if (proc && proc.exitCode === null) {
        proc.kill('SIGTERM');
        const exited = await waitForExit(proc, STOP_TIMEOUT_MS);
        if (!exited && proc.exitCode === null) {
          proc.kill('SIGKILL');
          await waitForExit(proc, STOP_TIMEOUT_MS);
        }
      }
    } finally {
      this.shutdownInternal('idle');
      this.stopPromise = null;
    }
  }

  public resetStats(): void {
    // Rebaseline counters against the current cumulative values so a "Reset"
    // press from the UI returns the displayed stats to zero immediately and
    // subsequent ticks compute deltas from this moment forward.
    // カウンタを現時点で再ベースライン化し、次の tick から差分表示を再開する。
    this.resetOffsets = {
      totalHashes: this.latestStats.totalHashes + this.resetOffsets.totalHashes,
      acceptedShares: this.latestStats.acceptedShares + this.resetOffsets.acceptedShares,
      rejectedShares: this.latestStats.rejectedShares + this.resetOffsets.rejectedShares,
    };
    if (this.startedAt !== null) this.startedAt = Date.now();
    this.latestStats = emptyStats();
    this.emit({ status: this.status, stats: this.getStats() });
  }

  private async resolveBinary(signal: AbortSignal): Promise<string> {
    const envBin = process.env['XMRIG_BIN'];
    if (envBin) return envBin;
    const onPath = await findXmrigOnPath();
    if (onPath) return onPath;
    return ensureXmrigBinary(this.options.cacheDir, this.options.onInstallProgress, signal);
  }

  private beginPolling(): void {
    this.endPolling();
    this.pollTimer = setInterval(() => {
      void this.pollSummary();
    }, POLL_INTERVAL_MS);
  }

  private endPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollSummary(): Promise<void> {
    if (!this.apiPort || !this.apiToken) return;
    // Capture the session token before the await. After the response comes
    // back we gate the update on both the same token and a still-running
    // status; without these, an in-flight summary fetch issued before
    // stop() can land after shutdownInternal('idle') resets state and
    // repopulate stale stats while the UI reads 'idle'.
    // session token を await 前に保持し、応答適用時に同一 session かつ running
    // であることを確認する。stop 後の遅延レスポンスで stale な値を書き戻さない。
    const generation = this.generation;
    try {
      const res = await fetch(`http://127.0.0.1:${this.apiPort}/2/summary`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const data = (await res.json()) as XmrigSummary;
      if (this.generation !== generation || this.status !== 'running') return;
      this.updateStatsFromSummary(data);
    } catch {
      // xmrig may still be initialising or a single request may have timed
      // out; skip this tick silently and let the next interval retry.
      // 起動直後 / 一時的なタイムアウトは無視して次の tick を待つ。
    }
  }

  private updateStatsFromSummary(data: XmrigSummary): void {
    const hashrateSamples = data.hashrate?.total ?? [];
    const sample = pickFirstFiniteNumber(hashrateSamples);
    const totalHashesAbs = clampNonNegative(data.results?.hashes_total);
    const goodAbs = clampNonNegative(data.results?.shares_good);
    const totalSharesAbs = clampNonNegative(data.results?.shares_total);
    const rejectedAbs = Math.max(0, totalSharesAbs - goodAbs);
    const uptimeSec =
      this.startedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));

    this.latestStats = {
      hashrate: sample,
      totalHashes: Math.max(0, totalHashesAbs - this.resetOffsets.totalHashes),
      acceptedShares: Math.max(0, goodAbs - this.resetOffsets.acceptedShares),
      rejectedShares: Math.max(0, rejectedAbs - this.resetOffsets.rejectedShares),
      uptimeSec,
    };
    this.emit({ status: this.status, stats: this.getStats() });
  }

  private async readLogTail(): Promise<string> {
    if (!this.logFilePath) return '';
    try {
      const data = await readFile(this.logFilePath, 'utf-8');
      const trimmed = data.trim();
      // Keep only the last ~600 chars so a long log doesn't flood the UI toast.
      // 長文ログで toast を埋めないよう末尾だけ抜く。
      return trimmed.length > 600 ? `…${trimmed.slice(-600)}` : trimmed;
    } catch {
      return '';
    }
  }

  private shutdownInternal(next: XmrigStatus, message?: string): void {
    this.endPolling();
    const proc = this.process;
    this.process = null;
    this.apiPort = null;
    this.apiToken = null;
    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* nothing to do */
      }
    }
    const dir = this.logDirPath;
    this.logDirPath = null;
    this.logFilePath = null;
    if (dir) {
      // Best-effort cleanup; we don't await because shutdown should be
      // synchronous from the listener's perspective and a stale tmpdir is harmless.
      // tmpdir の掃除は非同期で投げっぱなしにする。残っても害は無い。
      void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.startedAt = null;
    const stats = next === 'idle' ? emptyStats() : this.getStats();
    this.latestStats = stats;
    this.transition(next, message);
  }

  private transition(status: XmrigStatus, message?: string): void {
    this.status = status;
    const update: XmrigUpdate = { status, stats: this.getStats() };
    if (message !== undefined) update.message = message;
    this.emit(update);
  }

  private emit(update: XmrigUpdate): void {
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (err) {
        console.warn('[xmrig-runner] listener threw:', err);
      }
    }
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

function clampNonNegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function pickFirstFiniteNumber(samples: Array<number | null>): number {
  for (const sample of samples) {
    if (typeof sample === 'number' && Number.isFinite(sample) && sample >= 0) return sample;
  }
  return 0;
}

/**
 * Bind a transient TCP listener to 127.0.0.1:0 so the OS hands us a free port,
 * then release it before xmrig binds. There is a microscopic race window where
 * another process could grab the port between close() and xmrig binding, but
 * the alternative (asking xmrig to bind 0) means we cannot discover the chosen
 * port without parsing its log output — strictly worse.
 * 空きポートを掴むためのトリック。理論上はレースがあるが、xmrig 出力からポートを
 * 解析するより遥かに堅い。
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('failed to allocate api port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

export function parseStratumPool(input: string): ParsedPool | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const host = parts[0];
  const portStr = parts[1];
  if (!host || !portStr) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  const flag = parts[2]?.toLowerCase();
  const tls = flag === 'tls' || flag === 'ssl';
  return { host, port, tls };
}

export function buildXmrigArgs(
  config: MinerConfig,
  apiPort: number,
  apiToken: string,
  logFile?: string,
): string[] {
  const pool = parseStratumPool(config.pool);
  if (!pool) throw new Error(`invalid pool endpoint: ${config.pool}`);
  // Translate the UI throttle (0 = full power, 99 = 1%) into a concrete
  // reduced thread count plus an OS scheduling priority. Thread reduction
  // alone cannot honour the UI contract at small thread counts (threads=1
  // with throttle=99 has nothing to reduce), so we also lower the CPU
  // priority — at idle priority the OS only runs xmrig when nothing else
  // wants the core, which gives the user the strong-throttle behaviour the
  // slider implies even on single-thread configs.
  // throttle はスレッド数削減 + cpu-priority 低下の合わせ技で実現する。
  // 単一スレッド構成では数を減らせないので、scheduling priority で補う。
  const effectiveThreads = computeEffectiveThreads(config.threads, config.throttle);
  const cpuPriority = computeCpuPriority(config.throttle);
  const args: string[] = [
    '-o',
    `${pool.host}:${pool.port}`,
    '-u',
    config.walletAddress,
    '-p',
    config.password || 'x',
    '--coin',
    'monero',
    '-k',
    '--no-color',
    '--http-host',
    '127.0.0.1',
    '--http-port',
    String(apiPort),
    '--http-access-token',
    apiToken,
    '-t',
    String(effectiveThreads),
  ];
  // Send worker name via the dedicated rig-id field rather than mutating the
  // username with `wallet.worker`. Some pools require the username to be the
  // raw wallet string and reject the dotted form; the rig-id field is the
  // xmrig-idiomatic, broadly-compatible path.
  // worker 名は `--rig-id` で別フィールド送信。`wallet.worker` を強制すると
  // 一部プールで認証拒否される。
  if (config.workerId) args.push('--rig-id', config.workerId);
  if (logFile) args.push('-l', logFile);
  if (pool.tls) args.push('--tls');
  if (cpuPriority !== null) args.push('--cpu-priority', String(cpuPriority));
  return args;
}

export function computeEffectiveThreads(threads: number, throttle: number): number {
  if (!Number.isFinite(threads) || threads < 1) return 1;
  if (!Number.isFinite(throttle) || throttle <= 0) return Math.floor(threads);
  const remaining = Math.max(0, 100 - throttle) / 100;
  // Round to nearest so throttle=50 on 4 threads gives 2, but always keep at
  // least one thread running — a configured "Start" should never silently
  // produce a no-op miner. The cpu-priority drop (see computeCpuPriority)
  // covers the cases where rounding can't reduce further.
  // 最低 1 スレッドは保証。さらに削れない領域は priority 下げで補う。
  return Math.max(1, Math.round(threads * remaining));
}

/**
 * Map throttle (0–99) onto xmrig's `--cpu-priority` (0=idle … 5=realtime).
 * High throttle settings get OS idle priority so the miner only runs when
 * nothing else wants the CPU; moderate throttle gets below-normal; no
 * throttle returns null so we leave xmrig's default (normal) alone.
 * throttle を CPU 優先度に対応付ける。高 throttle = idle で他に譲る、低 throttle = デフォルト。
 */
export function computeCpuPriority(throttle: number): number | null {
  if (!Number.isFinite(throttle) || throttle <= 0) return null;
  if (throttle >= 50) return 0; // idle
  if (throttle >= 20) return 1; // below normal
  return null;
}
