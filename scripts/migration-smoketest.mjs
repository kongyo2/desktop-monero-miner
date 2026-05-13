// Standalone unit checks for the pool-migration helper in config-store.ts.
// We bundle a small shim that re-exports the helpers via esbuild so we can
// drive them under plain Node (the real ConfigStore pulls in electron-store
// which expects an Electron runtime).
// 旧設定マイグレーションを単体で検証する小さなランナー。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_STRATUM_PORT = 10128;

const shimSource = `
export function extractLegacyHost(input) {
  if (/^[a-z][a-z0-9+.-]*:\\/\\//iu.test(input)) {
    try {
      const url = new URL(input);
      return url.hostname || undefined;
    } catch {
      return undefined;
    }
  }
  const stripped = input.split(/[/?#]/u)[0] ?? '';
  const host = stripped.split(':')[0] ?? '';
  return host || undefined;
}

export function migrate(input) {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (/^[^:/?#]+:\\d+(?::(?:tls|ssl))?$/u.test(trimmed)) return trimmed;
  const host = extractLegacyHost(trimmed);
  return host ? host + ':${DEFAULT_STRATUM_PORT}' : undefined;
}
`;

const tmpDir = mkdtempSync(join(tmpdir(), 'migrate-test-'));
const entry = join(tmpDir, 'entry.mjs');
writeFileSync(entry, shimSource, 'utf-8');
const bundle = await build({
  entryPoints: [entry],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  bundle: true,
  write: false,
});
const bundlePath = join(tmpDir, 'bundle.cjs');
writeFileSync(bundlePath, bundle.outputFiles[0].text, 'utf-8');
const mod = await import(pathToFileURL(bundlePath).href);

// New format passes through untouched.
assert.equal(mod.migrate('gulf.moneroocean.stream:10128'), 'gulf.moneroocean.stream:10128');
assert.equal(mod.migrate('pool.example.com:3333:tls'), 'pool.example.com:3333:tls');
assert.equal(mod.migrate('pool.example.com:3333:ssl'), 'pool.example.com:3333:ssl');

// Bare hostname → host:DEFAULT_STRATUM_PORT
assert.equal(mod.migrate('moneroocean.stream'), `moneroocean.stream:${DEFAULT_STRATUM_PORT}`);

// URL form (the case Codex flagged) — host must be preserved, not "wss".
assert.equal(mod.migrate('wss://pool.example:443'), `pool.example:${DEFAULT_STRATUM_PORT}`);
assert.equal(
  mod.migrate('wss://ny1.xmrminingproxy.com'),
  `ny1.xmrminingproxy.com:${DEFAULT_STRATUM_PORT}`,
);
assert.equal(
  mod.migrate('ws://relay.example.com:8080/path?x=y'),
  `relay.example.com:${DEFAULT_STRATUM_PORT}`,
);
assert.equal(mod.migrate('https://pool.example.com'), `pool.example.com:${DEFAULT_STRATUM_PORT}`);

// Bare hostname with trailing path/query → strip them.
assert.equal(
  mod.migrate('moneroocean.stream/some/path?x=y'),
  `moneroocean.stream:${DEFAULT_STRATUM_PORT}`,
);

// Empty / whitespace → undefined (caller falls back to default).
assert.equal(mod.migrate(''), undefined);
assert.equal(mod.migrate('   '), undefined);

console.log('migration cases all pass');
