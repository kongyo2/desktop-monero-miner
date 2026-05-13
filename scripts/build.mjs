import { build, context } from 'esbuild';
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

async function run() {
  if (watch) {
    const ctxList = await Promise.all(builds.map((opts) => context(opts)));
    await Promise.all(ctxList.map((ctx) => ctx.watch()));
    await copyStaticAssets();
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
