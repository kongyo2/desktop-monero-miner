import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Pinned xmrig release that the runner downloads on first launch when no
 * pre-installed binary is found on PATH or via the XMRIG_BIN env var. Updating
 * the version requires updating both the constant and the per-platform asset
 * filenames in TARGETS below — the URL pattern is otherwise stable.
 * 同梱 xmrig のピン留めバージョン。更新時は TARGETS のアセットファイル名も合わせる。
 */
const XMRIG_VERSION = '6.22.2';

type Target = {
  /** Asset filename inside the GitHub release. */
  asset: string;
  /** Binary name relative to the extracted directory root. */
  binary: string;
};

/**
 * GitHub release asset naming follows `xmrig-<ver>-<platform>.<ext>` and is
 * stable across recent releases. Linux ships static builds so we don't pull in
 * an unknown libc; macOS ships separate x64 and arm64 archives; Windows ships
 * a single msvc zip with `xmrig.exe`.
 * GitHub リリースのアセット名は安定。Linux は static ビルドを採用して libc 依存を避ける。
 */
const TARGETS: Record<string, Target> = {
  'linux-x64': {
    asset: `xmrig-${XMRIG_VERSION}-linux-static-x64.tar.gz`,
    binary: `xmrig-${XMRIG_VERSION}/xmrig`,
  },
  'linux-arm64': {
    asset: `xmrig-${XMRIG_VERSION}-linux-static-arm64.tar.gz`,
    binary: `xmrig-${XMRIG_VERSION}/xmrig`,
  },
  'darwin-x64': {
    asset: `xmrig-${XMRIG_VERSION}-macos-x64.tar.gz`,
    binary: `xmrig-${XMRIG_VERSION}/xmrig`,
  },
  'darwin-arm64': {
    asset: `xmrig-${XMRIG_VERSION}-macos-arm64.tar.gz`,
    binary: `xmrig-${XMRIG_VERSION}/xmrig`,
  },
  'win32-x64': {
    asset: `xmrig-${XMRIG_VERSION}-msvc-win64.zip`,
    binary: `xmrig-${XMRIG_VERSION}/xmrig.exe`,
  },
};

export class XmrigInstallError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'XmrigInstallError';
  }
}

export type InstallProgress = (phase: 'download' | 'extract', detail: string) => void;

/**
 * Resolve the xmrig binary path, downloading and extracting the pinned release
 * into `cacheDir` if it is not already present. The cached layout under
 * cacheDir is `xmrig-<ver>/xmrig[.exe]`, so subsequent launches short-circuit
 * to the cached binary without touching the network.
 * xmrig バイナリを cacheDir 配下に展開済みなら即返し、無ければ取得して展開する。
 */
export async function ensureXmrigBinary(
  cacheDir: string,
  progress: InstallProgress = () => undefined,
): Promise<string> {
  const target = resolveTarget();
  const binaryPath = join(cacheDir, target.binary);
  if (existsSync(binaryPath)) {
    return binaryPath;
  }

  await mkdir(cacheDir, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), 'xmrig-dl-'));
  try {
    const archivePath = join(tmp, target.asset);
    const url = `https://github.com/xmrig/xmrig/releases/download/v${XMRIG_VERSION}/${target.asset}`;
    progress('download', url);
    await downloadFile(url, archivePath);
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
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `xmrig${ext}`);
      try {
        const st = await stat(candidate);
        if (st.isFile()) return candidate;
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
    throw new XmrigInstallError(`unsupported platform for xmrig auto-install: ${key}`);
  }
  return target;
}

/**
 * Stream a file from `url` to `dest`, following HTTP redirects up to a small
 * cap. GitHub release downloads always redirect to objects.githubusercontent
 * (with a signed URL), so a one-shot fetch must follow at least once; we cap
 * the redirect chain to defend against loops.
 * URL からファイルを保存。GitHub のリリース URL は必ずリダイレクトするので追従する。
 */
async function downloadFile(url: string, dest: string): Promise<void> {
  let current = url;
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(current, { redirect: 'manual' });
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
