import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Pinned xmrig release. The version, the per-platform asset filenames, and
 * their SHA-256 digests must all advance together — bumping the version
 * without updating the digests would break verification (correctly).
 * 同梱 xmrig のピン留め。version / アセット名 / SHA-256 はセットで更新する。
 */
const XMRIG_VERSION = '6.22.2';

/**
 * Hard cap on the time a single redirect-hop or body stream can take. Without
 * this, a stalled TCP connection during first-run install would leave
 * `ensureXmrigBinary()` (and therefore `start()`) pending forever, with no
 * way for the renderer to recover the UI. 2 minutes is plenty for a ~5–10 MB
 * archive even on slow links; for fast ones the actual download finishes in
 * seconds and the timer is a no-op.
 * 個別 fetch / body ストリームのタイムアウト。これが無いと回線停止時に
 * install が永遠に終わらず renderer が固まる。
 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

type Target = {
  /** Asset filename inside the GitHub release. */
  asset: string;
  /** Binary path relative to the extracted directory root. */
  binary: string;
  /**
   * Lowercase hex SHA-256 digest of the release asset, pinned in source so a
   * compromised CDN / redirect / TLS endpoint cannot silently slip a swapped
   * binary into the main-process spawn. Sourced from the SHA256SUMS file
   * published alongside the release on https://github.com/xmrig/xmrig/releases.
   * 公式リリースに同梱の SHA256SUMS から拾ってベタ書き。検証失敗時はファイルを破棄する。
   */
  sha256: string;
};

/**
 * GitHub release asset naming follows `xmrig-<ver>-<platform>.<ext>` and is
 * stable across recent releases. Linux ships a single static build for x64;
 * macOS ships separate x64 and arm64 archives; Windows ships an MSVC zip
 * containing `xmrig.exe`. xmrig does not publish a Linux arm64 static binary,
 * so users on that platform must supply XMRIG_BIN or install xmrig manually.
 * Linux arm64 は公式静的ビルドが無いため、自動 DL 対象外（PATH / XMRIG_BIN 経由で利用してもらう）。
 */
const TARGETS: Record<string, Target> = {
  'linux-x64': {
    asset: `xmrig-${XMRIG_VERSION}-linux-static-x64.tar.gz`,
    binary: `xmrig-${XMRIG_VERSION}/xmrig`,
    sha256: 'b2c88b19699e3d22c4db0d589f155bb89efbd646ecf9ad182ad126763723f4b7',
  },
  'darwin-x64': {
    asset: `xmrig-${XMRIG_VERSION}-macos-x64.tar.gz`,
    binary: `xmrig-${XMRIG_VERSION}/xmrig`,
    sha256: '868b0622da3a6ce522c69cfb1ce7c0e7f4514887f427a7accc485be2dfb933fb',
  },
  'darwin-arm64': {
    asset: `xmrig-${XMRIG_VERSION}-macos-arm64.tar.gz`,
    binary: `xmrig-${XMRIG_VERSION}/xmrig`,
    sha256: '625375bf2f5ba609c8034667ef8073e81c0e864df224fa57386a754e788fc6ce',
  },
  'win32-x64': {
    asset: `xmrig-${XMRIG_VERSION}-msvc-win64.zip`,
    binary: `xmrig-${XMRIG_VERSION}/xmrig.exe`,
    sha256: '1d903d39c7e4e1706c32c44721d6a6c851aa8c4c10df1479478ee93cd67301bc',
  },
};

export class XmrigInstallError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'XmrigInstallError';
  }
}

export type InstallProgress = (phase: 'download' | 'verify' | 'extract', detail: string) => void;

/**
 * Resolve the xmrig binary path, downloading and extracting the pinned release
 * into `cacheDir` if it is not already present. The downloaded archive is
 * verified against a pinned SHA-256 before extraction; a mismatch deletes the
 * file and aborts the install rather than running attacker-controlled bytes.
 * The cached layout is `xmrig-<ver>/xmrig[.exe]`, so subsequent launches
 * short-circuit to the cached binary without touching the network. Pass an
 * AbortSignal to allow the caller (e.g. XmrigRunner on Stop) to cancel a
 * long-running install before it finishes; the rejection propagates out as
 * the signal's abort reason so the start() promise can settle cleanly.
 * 展開済みなら即返し、無ければ取得→SHA-256 検証→展開。caller 側の Stop で abort 可能。
 */
export async function ensureXmrigBinary(
  cacheDir: string,
  progress: InstallProgress = () => undefined,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const target = resolveTarget();
  const binaryPath = join(cacheDir, target.binary);
  if (existsSync(binaryPath)) {
    return binaryPath;
  }

  await mkdir(cacheDir, { recursive: true });
  signal?.throwIfAborted();
  const tmp = await mkdtemp(join(tmpdir(), 'xmrig-dl-'));
  try {
    signal?.throwIfAborted();
    const archivePath = join(tmp, target.asset);
    const url = `https://github.com/xmrig/xmrig/releases/download/v${XMRIG_VERSION}/${target.asset}`;
    progress('download', url);
    await downloadFile(url, archivePath, signal);
    signal?.throwIfAborted();
    progress('verify', target.sha256);
    const actual = await sha256OfFile(archivePath);
    if (actual !== target.sha256) {
      throw new XmrigInstallError(
        `xmrig archive checksum mismatch for ${target.asset}: expected ${target.sha256}, got ${actual}`,
      );
    }
    signal?.throwIfAborted();
    progress('extract', archivePath);
    await extractArchive(archivePath, cacheDir);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }

  if (!existsSync(binaryPath)) {
    throw new XmrigInstallError(`xmrig binary not found after extraction: ${binaryPath}`);
  }
  if (process.platform !== 'win32') {
    await chmod(binaryPath, 0o755).catch(() => undefined);
  }
  return binaryPath;
}

/**
 * Walk PATH manually so the lookup works in renderer/main processes alike
 * without relying on shell builtins. Returns null when the binary is absent
 * rather than throwing, so callers can chain to the auto-download fallback.
 * PATH を自力で走査して xmrig を探す。見つからなければ null を返し、
 * 呼び出し側で自動ダウンロード経路へフォールバックさせる。
 */
export async function findXmrigOnPath(): Promise<string | null> {
  const pathEnv = process.env['PATH'];
  if (!pathEnv) return null;
  const sep = process.platform === 'win32' ? ';' : ':';
  // Only return extensions Node can spawn directly with shell: false. On
  // Windows that is .exe (and .com, but xmrig never ships as one); .cmd and
  // .bat require shell mediation, so accepting them here would make path
  // discovery report success and then fail at spawn time.
  // shell:false で直接 spawn 可能な拡張子のみ受理。.cmd/.bat は shell 必須なので除外。
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `xmrig${ext}`);
      try {
        const st = await stat(candidate);
        if (!st.isFile()) continue;
        // Require execute permission on Unix-like platforms so a stale or
        // non-executable PATH entry doesn't shadow the auto-download
        // fallback. On Windows, .exe is implicitly executable and access()
        // with X_OK is not meaningful, so we skip the check there.
        // Unix では実行権限を必須に。X 権限の無い stale ファイルで詰まらないようにする。
        if (process.platform !== 'win32') {
          try {
            await access(candidate, fsConstants.X_OK);
          } catch {
            continue;
          }
        }
        return candidate;
      } catch {
        /* not present, try next */
      }
    }
  }
  return null;
}

function resolveTarget(): Target {
  const key = `${process.platform}-${process.arch}`;
  const target = TARGETS[key];
  if (!target) {
    throw new XmrigInstallError(
      `no pinned xmrig binary for ${key}; install xmrig manually or set XMRIG_BIN`,
    );
  }
  return target;
}

/**
 * Stream-hash a file with SHA-256. Streaming avoids loading the whole archive
 * (multi-megabyte) into memory just to compute its digest.
 * ファイルを stream で SHA-256 化。アーカイブを丸ごとメモリに乗せないため。
 */
async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Stream a file from `url` to `dest`, following HTTP redirects up to a small
 * cap. GitHub release downloads always redirect to objects.githubusercontent
 * (with a signed URL), so a one-shot fetch must follow at least once; we cap
 * the redirect chain to defend against loops.
 * URL からファイルを保存。GitHub のリリース URL は必ずリダイレクトするので追従する。
 */
async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  let current = url;
  for (let i = 0; i < 5; i += 1) {
    signal?.throwIfAborted();
    // Combine the caller's cancellation signal with a per-hop timeout so
    // the fetch aborts on whichever fires first. fetch's signal propagates
    // to the body stream too, so a stall during streamed download also
    // rejects rather than hanging indefinitely.
    // caller のキャンセル signal とホップ毎タイムアウトを合成。body にも伝播するので
    // ダウンロード中の停止も拾える。
    const combined = combineSignals(signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
    const res = await fetch(current, { redirect: 'manual', signal: combined });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new XmrigInstallError(`redirect without location: ${current}`);
      current = new URL(next, current).toString();
      continue;
    }
    if (!res.ok || !res.body) {
      throw new XmrigInstallError(`download failed: ${res.status} ${res.statusText} (${current})`);
    }
    await mkdir(dirname(dest), { recursive: true });
    const fileStream = createWriteStream(dest);
    await pipeline(Readable.fromWeb(res.body as never), fileStream);
    return;
  }
  throw new XmrigInstallError(`too many redirects fetching ${url}`);
}

/**
 * Compose two abort signals into one that aborts on whichever fires first.
 * Equivalent to `AbortSignal.any([a, b])` from Node 20.3+, but written
 * explicitly so the package's `>=20.0.0` engines constraint stays honest.
 * 二つの signal を合成。AbortSignal.any 相当だが、Node 20 系下位互換のため自前実装。
 */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const onAbortA = (): void => controller.abort(a.reason);
  const onAbortB = (): void => controller.abort(b.reason);
  a.addEventListener('abort', onAbortA, { once: true });
  b.addEventListener('abort', onAbortB, { once: true });
  return controller.signal;
}

/**
 * Extract an archive using the system `tar` binary. `tar` on Linux/macOS
 * handles .tar.gz natively, and on Windows 10+ it also handles .zip via the
 * bundled libarchive backend, so a single code path covers all targets.
 * tar コマンドで展開。Win10+ の tar は zip も扱えるため一本化できる。
 */
async function extractArchive(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', dest], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new XmrigInstallError(`tar exited with code ${code}`));
    });
  });
  await ensureBinaryLayout(dest);
}

/**
 * Some xmrig archives unpack into `xmrig-<ver>/` while older ones unpack flat.
 * Normalise the flat case by moving the binary into the expected
 * `xmrig-<ver>/xmrig[.exe]` layout so the caller's resolved path is stable.
 * 旧フォーマットでフラット展開された場合に備え、想定レイアウトへ揃える。
 */
async function ensureBinaryLayout(dest: string): Promise<void> {
  const target = resolveTarget();
  const expected = join(dest, target.binary);
  if (existsSync(expected)) return;
  const binName = process.platform === 'win32' ? 'xmrig.exe' : 'xmrig';
  try {
    const entries = await readdir(dest);
    for (const entry of entries) {
      const candidate = join(dest, entry);
      const direct = join(candidate, binName);
      if (existsSync(direct)) {
        const versioned = join(dest, `xmrig-${XMRIG_VERSION}`);
        if (candidate !== versioned) {
          await rename(candidate, versioned).catch(() => undefined);
        }
        return;
      }
    }
  } catch {
    /* ignore — caller will raise the missing-binary error below */
  }
}
