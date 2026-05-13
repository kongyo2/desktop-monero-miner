import { build, context } from 'esbuild';
import { watch as fsWatch } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const srcDir = resolve(rootDir, 'src');
const outDir = resolve(rootDir, 'dist');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const commonNode = {
  platform: 'node',
  format: 'cjs',
  bundle: true,
  sourcemap: true,
  target: 'node20',
  external: ['electron', 'electron-store'],
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...commonNode,
    entryPoints: [join(srcDir, 'main', 'index.ts')],
    outfile: join(outDir, 'main', 'index.js'),
  },
  {
    ...commonNode,
    entryPoints: [join(srcDir, 'preload', 'index.ts')],
    outfile: join(outDir, 'preload', 'index.js'),
  },
  {
    entryPoints: [join(srcDir, 'renderer', 'index.ts')],
    outfile: join(outDir, 'renderer', 'index.js'),
    platform: 'browser',
    format: 'esm',
    bundle: true,
    sourcemap: true,
    target: ['chrome120'],
    logLevel: 'info',
  },
];

async function copyStaticAssets() {
  const rendererSrc = join(srcDir, 'renderer');
  const rendererOut = join(outDir, 'renderer');
  await mkdir(rendererOut, { recursive: true });

  const entries = await readdir(rendererSrc, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.html') && !entry.name.endsWith('.css')) continue;
    await copyFile(join(rendererSrc, entry.name), join(rendererOut, entry.name));
  }
}

function watchStaticAssets() {
  const rendererSrc = join(srcDir, 'renderer');
  let pending = false;
  let rerun = false;
  const trigger = () => {
    if (pending) {
      rerun = true;
      return;
    }
    pending = true;
    copyStaticAssets()
      .then(() => {
        console.log('[build] Copied static assets.');
      })
      .catch((err) => {
        console.error('[build] copyStaticAssets failed:', err);
      })
      .finally(() => {
        pending = false;
        if (rerun) {
          rerun = false;
          trigger();
        }
      });
  };
  // recursive: true is supported on macOS and Windows; Linux 6+ also supports
  // it as of Node 20. On unsupported platforms Node falls back to watching the
  // top-level directory only, which still catches edits to *.html/*.css.
  // recursive はプラットフォーム依存ですが、対応外でもトップレベル直下の変更は拾えます。
  const watcher = fsWatch(rendererSrc, { persistent: true, recursive: true }, (_event, file) => {
    if (typeof file !== 'string') return;
    if (!file.endsWith('.html') && !file.endsWith('.css')) return;
    trigger();
  });
  watcher.on('error', (err) => {
    console.error('[build] fs.watch error:', err);
  });
}

async function run() {
  if (watch) {
    const ctxList = await Promise.all(builds.map((opts) => context(opts)));
    await Promise.all(ctxList.map((ctx) => ctx.watch()));
    await copyStaticAssets();
    watchStaticAssets();
    console.log('[build] Watching for changes...');
    return;
  }

  await Promise.all(builds.map((opts) => build(opts)));
  await copyStaticAssets();
  console.log('[build] Done.');
}

run().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});
