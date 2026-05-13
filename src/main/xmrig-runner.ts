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
  /** Optional progress sink for download/extract phases of first-launch install. */
  onInstallProgress?: (phase: 'download' | 'extract', detail: string) => void;
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

  public async start(config: MinerConfig): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return;
    const generation = ++this.generation;
    this.transition('starting');

    try {
      const binary = await this.resolveBinary();
      if (generation !== this.generation) return;

      const apiPort = await pickFreePort();
      const apiToken = randomBytes(16).toString('hex');
      this.apiPort = apiPort;
      this.apiToken = apiToken;
      const logDir = await mkdtemp(join(tmpdir(), 'xmrig-log-'));
      const logFile = join(logDir, 'xmrig.log');
      this.logDirPath = logDir;
      this.logFilePath = logFile;
      const args = buildXmrigArgs(config, apiPort, apiToken, logFile);

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
      const message = cause instanceof Error ? cause.message : String(cause);
      this.shutdownInternal('error', message);
      throw cause;
    }
  }

  public async stop(): Promise<void> {
    this.generation += 1;
    if (this.status === 'idle' || this.status === 'stopping') {
      this.shutdownInternal('idle');
      return;
    }
    this.transition('stopping');
    this.endPolling();
    const proc = this.process;
    if (!proc || proc.exitCode !== null) {
      this.shutdownInternal('idle');
      return;
    }
    proc.kill('SIGTERM');
    const exited = await waitForExit(proc, STOP_TIMEOUT_MS);
    if (!exited && proc.exitCode === null) {
      proc.kill('SIGKILL');
      await waitForExit(proc, STOP_TIMEOUT_MS);
    }
    this.shutdownInternal('idle');
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

  private async resolveBinary(): Promise<string> {
    const envBin = process.env['XMRIG_BIN'];
    if (envBin) return envBin;
    const onPath = await findXmrigOnPath();
    if (onPath) return onPath;
    return ensureXmrigBinary(this.options.cacheDir, this.options.onInstallProgress);
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
    try {
      const res = await fetch(`http://127.0.0.1:${this.apiPort}/2/summary`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as XmrigSummary;
      this.updateStatsFromSummary(data);
    } catch {
      // xmrig may still be initialising; skip this tick silently.
      // 起動直後など HTTP サーバが立ち上がる前は無視して次の tick を待つ。
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
  const login = config.workerId
    ? `${config.walletAddress}.${config.workerId}`
    : config.walletAddress;
  const args: string[] = [
    '-o',
    `${pool.host}:${pool.port}`,
    '-u',
    login,
    '-p',
    config.password || 'x',
    '--coin',
    'monero',
    '-k',
    '--no-color',
    '--randomx-no-rdmsr',
    '--http-host',
    '127.0.0.1',
    '--http-port',
    String(apiPort),
    '--http-access-token',
    apiToken,
    '-t',
    String(config.threads),
  ];
  if (logFile) args.push('-l', logFile);
  if (pool.tls) args.push('--tls');
  if (config.throttle > 0) {
    // xmrig's `--cpu-max-threads-hint` caps the share of detected CPU threads
    // used by the miner. Throttle in our UI is "% slowdown", so the actual
    // utilization hint is 100 - throttle. Clamp to 1 because xmrig refuses 0.
    // 設定の throttle は「遅くする割合」。xmrig の hint は逆向きなので 100 から引く。
    const hint = Math.max(1, 100 - config.throttle);
    args.push('--cpu-max-threads-hint', String(hint));
  }
  return args;
}
