import { build } from 'esbuild';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

const bundle = await build({
  entryPoints: ['src/main/stratum-proxy.ts'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  bundle: true,
  write: false,
});
const tmpDir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
const bundlePath = join(tmpDir, 'proxy.cjs');
writeFileSync(bundlePath, bundle.outputFiles[0].text, 'utf-8');
const mod = await import(pathToFileURL(bundlePath).href);

const proxy = new mod.StratumProxy();
const url = await proxy.start();
console.log('proxy listening at', url);

// 1) Invalid pool format → expect rejected, then close.
{
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      identifier: 'handshake',
      pool: 'not-a-host',
      login:
        '49aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userid: 'test',
      password: 'x',
      version: 7,
    }),
  );
  const got = await new Promise((resolve) => {
    ws.once('message', (data) => resolve(data.toString()));
    ws.once('close', () => resolve('<closed-without-msg>'));
  });
  console.log('invalid-pool response:', got);
  ws.close();
}

// 2) Fake Stratum: accept TCP, immediately close. Expect proxy to close ws.
const fake = await new Promise((resolve, reject) => {
  const s = createServer((sock) => sock.end());
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => resolve({ srv: s, port: s.address().port }));
});
{
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      identifier: 'handshake',
      pool: `127.0.0.1:${fake.port}`,
      login:
        '49aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userid: 'test',
      password: 'x',
      version: 7,
    }),
  );
  const closed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('<timeout>'), 4000);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve('<closed>');
    });
    ws.once('error', () => {
      clearTimeout(timer);
      resolve('<errored>');
    });
  });
  console.log('fake-pool result:', closed);
  ws.close();
}
fake.srv.close();

// 3) Fake Stratum: accept TCP, speak a tiny login OK then push a job.
const fake2 = await new Promise((resolve, reject) => {
  const s = createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method === 'login') {
          sock.write(
            JSON.stringify({
              id: msg.id,
              jsonrpc: '2.0',
              result: {
                id: 'session-1',
                status: 'OK',
                job: {
                  job_id: 'j1',
                  blob: '00'.repeat(76),
                  target: 'ffffffff',
                  algo: 'cn/r',
                  height: 100,
                },
              },
              error: null,
            }) + '\n',
          );
        }
      }
    });
  });
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => resolve({ srv: s, port: s.address().port }));
});
{
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const received = [];
  ws.on('message', (data) => received.push(JSON.parse(data.toString())));
  ws.send(
    JSON.stringify({
      identifier: 'handshake',
      pool: `127.0.0.1:${fake2.port}`,
      login:
        '49aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userid: 'test-worker',
      password: 'x',
      version: 7,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log('job-forward result:', JSON.stringify(received));
  ws.close();
}
fake2.srv.close();

await proxy.stop();
console.log('proxy stopped cleanly');
