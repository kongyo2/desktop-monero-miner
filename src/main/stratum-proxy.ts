import { createServer, type Server as HttpServer } from 'node:http';
import { Socket } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import { type WebSocket as WSWebSocket, WebSocketServer } from 'ws';

/**
 * Local WebSocket→Stratum bridge spawned by the main process.
 *
 * The renderer's pinned miner script speaks a small custom WebSocket protocol
 * (NajmAjmal/monero-webminer):
 *   client → server: {"identifier":"handshake", pool, login, password, userid, version}
 *   client → server: {"identifier":"solved",    job_id, nonce, result}
 *   server → client: {"identifier":"job",       job_id, blob, target, algo, variant, height}
 *
 * Pools speak Cryptonote/Monero Stratum over TCP (optionally TLS) with one
 * JSON-RPC document per line:
 *   {"id":N, "jsonrpc":"2.0", "method":"login",     "params":{login,pass,agent,rigid}}
 *   {"id":N, "jsonrpc":"2.0", "method":"submit",    "params":{id,job_id,nonce,result}}
 *   {       "jsonrpc":"2.0", "method":"job",       "params":{job_id,blob,target,algo,...}}
 *
 * This proxy accepts each WebSocket connection, opens an outbound TCP/TLS
 * socket to the pool addressed by the handshake, performs the protocol
 * translation in both directions, and surfaces share-acceptance/rejection
 * back to the renderer as synthetic {"identifier":"accepted"|"rejected"}
 * messages so the UI stats reflect real pool responses.
 *
 * 既存のレンダラ採掘スクリプト（独自の identifier 形式）と、プール側の
 * 標準 Cryptonote Stratum を相互翻訳するためのローカルブリッジ。main プロセス
 * から spawn することで、外部 WebSocket プロキシ（xmrminingproxy.com など）
 * に依存せずデスクトップアプリ単体で完結させる。
 */

const PROXY_AGENT = 'desktop-monero-miner-proxy/0.1';
const KEEPALIVE_INTERVAL_MS = 30_000;
/**
 * Pools eventually drop idle TCP sockets; we surface that as a clean
 * shutdown to the renderer rather than letting it hang on a dead socket.
 * プールは無通信の TCP を一定時間で切断する。renderer 側で待ち続けないよう、
 * その状態を検知して明示的にクローズする。
 */
const POOL_SOCKET_TIMEOUT_MS = 120_000;

type StratumJob = {
  job_id: string;
  blob: string;
  target: string;
  algo?: string;
  variant?: number;
  height?: number;
  seed_hash?: string;
};

type StratumIncoming =
  | { id?: number; method?: string; params?: StratumJob; result?: unknown; error?: unknown }
  | Record<string, unknown>;

type ParsedPool = {
  host: string;
  port: number;
  tls: boolean;
};

export class StratumProxy {
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private address: string | null = null;
  private bridges = new Set<StratumBridge>();
  /**
   * Cached promise of the currently running bind/listen. Callers that arrive
   * while bind is still in flight all await the same promise instead of
   * spinning up parallel HTTP servers — without this, the later completion
   * would overwrite this.httpServer/this.wss and leak the earlier listeners
   * past stop().
   * 同時並行で start() が呼ばれてもサーバを 1 つに収束させるための共有 Promise。
   * これが無いと先に bind したリスナーが孤立して stop() で閉じられない。
   */
  private startPromise: Promise<string> | null = null;

  public start(): Promise<string> {
    if (this.address) return Promise.resolve(this.address);
    if (this.startPromise) return this.startPromise;
    const promise = this.bind().catch((err) => {
      // Drop the cached promise so the next caller retries instead of
      // re-receiving the original failure forever.
      // 失敗時は cache をクリアし、次回呼び出しでリトライ可能にする。
      if (this.startPromise === promise) this.startPromise = null;
      throw err;
    });
    this.startPromise = promise;
    return promise;
  }

  public getAddress(): string | null {
    return this.address;
  }

  public async stop(): Promise<void> {
    for (const bridge of this.bridges) {
      bridge.shutdown();
    }
    this.bridges.clear();
    const wss = this.wss;
    const server = this.httpServer;
    this.wss = null;
    this.httpServer = null;
    this.address = null;
    this.startPromise = null;
    await Promise.all([
      new Promise<void>((resolve) => {
        if (!wss) return resolve();
        wss.close(() => resolve());
      }),
      new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
    ]);
  }

  private async bind(): Promise<string> {
    const server = createServer((_req, res) => {
      // The renderer only opens WebSocket upgrades; any plain HTTP hit is
      // either a misconfiguration or a probe. Reply tersely instead of
      // exposing handler stack traces.
      // HTTP GET は想定外。ハンドラのスタックを露出させないよう短く返す。
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Bind to loopback only so the proxy is never reachable from outside
      // the host machine. Port 0 lets the OS assign a free port.
      // ループバック専用にバインドし、外部から到達不能にする。0 を渡して
      // 空きポートを OS に割り当てさせる。
      server.listen(0, '127.0.0.1');
    });

    const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });
    wss.on('connection', (ws) => {
      const bridge = new StratumBridge(ws, () => this.bridges.delete(bridge));
      this.bridges.add(bridge);
      bridge.start();
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      wss.close();
      server.close();
      throw new Error('stratum_proxy_bind_failed');
    }
    this.httpServer = server;
    this.wss = wss;
    this.address = `ws://127.0.0.1:${addr.port}`;
    return this.address;
  }
}

class StratumBridge {
  private readonly ws: WSWebSocket;
  private readonly onClose: () => void;
  private pool: Socket | TLSSocket | null = null;
  private buffer = '';
  private loginId: string | null = null;
  private nextRpcId = 1;
  private loginRpcId: number | null = null;
  private pendingSubmits = new Map<number, { job_id: string }>();
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private closed = false;

  public constructor(ws: WSWebSocket, onClose: () => void) {
    this.ws = ws;
    this.onClose = onClose;
  }

  public start(): void {
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.handleClientFrame(typeof data === 'string' ? data : data.toString('utf-8'));
    });
    this.ws.on('close', () => this.shutdown());
    this.ws.on('error', (err) => {
      console.warn('[stratum-proxy] ws error:', err.message);
      this.shutdown();
    });
  }

  public shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.pool) {
      try {
        this.pool.destroy();
      } catch {
        /* nothing to do */
      }
      this.pool = null;
    }
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      try {
        this.ws.close();
      } catch {
        /* nothing to do */
      }
    }
    this.onClose();
  }

  private handleClientFrame(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const identifier = msg['identifier'];
    if (identifier === 'handshake') {
      this.openPool(msg);
    } else if (identifier === 'solved') {
      this.submitShare(msg);
    }
  }

  private openPool(handshake: Record<string, unknown>): void {
    if (this.pool) return;
    const endpoint = parsePool(toStringOr(handshake['pool'], ''));
    if (!endpoint) {
      this.sendClient({ identifier: 'rejected', error: { message: 'invalid_pool_endpoint' } });
      this.shutdown();
      return;
    }

    const wallet = toStringOr(handshake['login'], '').trim();
    if (!wallet) {
      this.sendClient({ identifier: 'rejected', error: { message: 'missing_wallet_address' } });
      this.shutdown();
      return;
    }
    const workerId = toStringOr(handshake['userid'], '').trim();
    const password = toStringOr(handshake['password'], '') || 'x';

    const onConnect = (): void => {
      const id = this.nextRpcId++;
      this.loginRpcId = id;
      const login = workerId ? `${wallet}.${workerId}` : wallet;
      this.sendPool({
        id,
        jsonrpc: '2.0',
        method: 'login',
        params: { login, pass: password, agent: PROXY_AGENT, rigid: workerId || undefined },
      });
      this.keepAliveTimer = setInterval(() => this.sendKeepAlive(), KEEPALIVE_INTERVAL_MS);
    };

    let sock: Socket | TLSSocket;
    if (endpoint.tls) {
      sock = tlsConnect(
        { host: endpoint.host, port: endpoint.port, servername: endpoint.host },
        onConnect,
      );
    } else {
      sock = new Socket();
      sock.once('connect', onConnect);
      sock.connect(endpoint.port, endpoint.host);
    }
    sock.setTimeout(POOL_SOCKET_TIMEOUT_MS);
    sock.on('data', (chunk: Buffer) => this.handlePoolData(chunk));
    sock.on('timeout', () => {
      console.warn('[stratum-proxy] pool socket idle timeout');
      this.shutdown();
    });
    sock.on('close', () => this.shutdown());
    sock.on('error', (err) => {
      console.warn('[stratum-proxy] pool socket error:', err.message);
      this.sendClient({ identifier: 'rejected', error: { message: err.message } });
      this.shutdown();
    });
    this.pool = sock;
  }

  private handlePoolData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    while (true) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: StratumIncoming | null = null;
      try {
        msg = JSON.parse(line) as StratumIncoming;
      } catch {
        continue;
      }
      if (msg) this.dispatchPoolMessage(msg);
    }
  }

  private dispatchPoolMessage(msg: StratumIncoming): void {
    const method = (msg as { method?: unknown })['method'];
    if (method === 'job') {
      const params = (msg as { params?: StratumJob }).params;
      if (params) this.forwardJob(params);
      return;
    }

    const id = (msg as { id?: unknown })['id'];
    const result = (msg as { result?: unknown }).result;
    const error = (msg as { error?: unknown }).error;

    if (typeof id === 'number' && id === this.loginRpcId) {
      // Login response. Success carries {id, job, status:"OK"}; failure carries
      // error: {code, message}. We never get a second login result.
      // ログイン応答。成功時は session id とジョブが result に入り、失敗時は
      // error フィールドで通知される。ログインの id は 1 回しか発火しない。
      this.loginRpcId = null;
      if (
        result &&
        typeof result === 'object' &&
        'id' in result &&
        typeof (result as { id: unknown }).id === 'string'
      ) {
        this.loginId = (result as { id: string }).id;
        const job = (result as { job?: StratumJob }).job;
        if (job) this.forwardJob(job);
      }
      if (error) {
        this.sendClient({ identifier: 'rejected', error });
        this.shutdown();
      }
      return;
    }

    if (typeof id === 'number' && this.pendingSubmits.has(id)) {
      const ctx = this.pendingSubmits.get(id);
      this.pendingSubmits.delete(id);
      if (!ctx) return;
      if (
        result &&
        typeof result === 'object' &&
        (result as { status?: unknown }).status === 'OK'
      ) {
        this.sendClient({ identifier: 'accepted', job_id: ctx.job_id });
      } else {
        this.sendClient({ identifier: 'rejected', job_id: ctx.job_id, error: error ?? null });
      }
    }
  }

  private forwardJob(job: StratumJob): void {
    const algo = mapAlgoForWorker(job.algo);
    if (algo === null) {
      // The worker only supports CryptoNight family; reject jobs from
      // RandomX/RandomKEVA/etc pools so the user sees a clear error instead of
      // a silent stall.
      // ワーカーは CryptoNight 系のみ対応。RandomX 系のジョブが届いた場合は
      // 明示的に拒否してユーザにフィードバックする。
      this.sendClient({
        identifier: 'rejected',
        error: { message: `unsupported_algo:${job.algo ?? 'unknown'}` },
      });
      this.shutdown();
      return;
    }
    const variant = job.variant ?? variantFromAlgoSuffix(job.algo);
    this.sendClient({
      identifier: 'job',
      job_id: job.job_id,
      blob: job.blob,
      target: job.target,
      algo,
      variant,
      height: job.height ?? 0,
    });
  }

  private submitShare(solved: Record<string, unknown>): void {
    if (!this.loginId || !this.pool) return;
    const jobId = toStringOr(solved['job_id'], '');
    if (!jobId) return;
    const id = this.nextRpcId++;
    this.pendingSubmits.set(id, { job_id: jobId });
    this.sendPool({
      id,
      jsonrpc: '2.0',
      method: 'submit',
      params: {
        id: this.loginId,
        job_id: jobId,
        nonce: toStringOr(solved['nonce'], ''),
        result: toStringOr(solved['result'], ''),
      },
    });
  }

  private sendKeepAlive(): void {
    if (!this.loginId || !this.pool) return;
    const id = this.nextRpcId++;
    this.sendPool({
      id,
      jsonrpc: '2.0',
      method: 'keepalived',
      params: { id: this.loginId },
    });
  }

  private sendPool(payload: unknown): void {
    if (!this.pool) return;
    try {
      this.pool.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      console.warn('[stratum-proxy] pool write failed:', err instanceof Error ? err.message : err);
    }
  }

  private sendClient(payload: unknown): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.warn('[stratum-proxy] ws send failed:', err instanceof Error ? err.message : err);
    }
  }
}

function toStringOr(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function parsePool(input: string): ParsedPool | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Accept "host:port" or "host:port:tls" (also "ssl" as a synonym).
  // "host:port" または "host:port:tls" を受理。ssl は tls の別名。
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

function mapAlgoForWorker(algo: string | undefined): string | null {
  if (!algo) return 'cn';
  const lower = algo.toLowerCase();
  if (lower.startsWith('rx') || lower.startsWith('randomx')) return null;
  if (lower.startsWith('cn-lite') || lower.startsWith('cryptonight-lite')) return 'cn-lite';
  if (lower.startsWith('cn-pico') || lower.startsWith('cryptonight-pico')) return 'cn-pico';
  if (lower.startsWith('cn-half') || lower.startsWith('cryptonight-half')) return 'cn-half';
  if (lower.startsWith('cn') || lower.startsWith('cryptonight')) return 'cn';
  return null;
}

function variantFromAlgoSuffix(algo: string | undefined): number {
  if (!algo) return 0;
  const slash = algo.indexOf('/');
  if (slash < 0) return 0;
  const suffix = algo.slice(slash + 1);
  if (suffix === 'r') return 1;
  if (suffix === '2') return 2;
  if (suffix === '1') return 1;
  const n = Number(suffix);
  return Number.isFinite(n) ? n : 0;
}
