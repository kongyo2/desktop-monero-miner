import Store from 'electron-store';

import {
  type AppPreferences,
  DEFAULT_STRATUM_PORT,
  type PartialAppPreferences,
  type PartialMinerConfig,
  type PersistedState,
  persistedStateSchema,
} from '../shared/config-schema.ts';

const defaultState: PersistedState = persistedStateSchema.parse({});

type StoreShape = { state: PersistedState };

function applyDefined<T extends object>(base: T, patch: { [K in keyof T]?: T[K] | undefined }): T {
  const result: T = { ...base };
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Coerce persisted state from older app versions before strict validation.
 *
 * Pre-proxy releases stored `pool` as a bare hostname (e.g. "moneroocean.stream")
 * because the actual TCP destination lived in `webSocket` (an external WS
 * relay). The new schema requires `pool` to be a Stratum endpoint
 * `host:port[:tls]`. Without this migration the whole persistedStateSchema
 * parse fails and the user loses every other saved field (wallet, threads…)
 * back to defaults — a much worse UX than a one-time pool-field coercion.
 *
 * 旧バージョンでは pool は単なるホスト名で保存されており、新スキーマの
 * host:port[:tls] バリデーションに通らない。ここで補正しないと
 * persistedStateSchema 全体の parse が失敗し、ウォレットアドレスなど
 * 関係ない設定まで初期化されてしまう。
 */
function migrateRawState(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const next = { ...(raw as Record<string, unknown>) };
  const config = next['config'];
  if (!config || typeof config !== 'object') return next;
  const cfg = { ...(config as Record<string, unknown>) };
  const pool = cfg['pool'];
  if (typeof pool === 'string') {
    const trimmed = pool.trim();
    if (trimmed && !/^[^:/?#]+:\d+(?::(?:tls|ssl))?$/u.test(trimmed)) {
      const host = extractLegacyHost(trimmed);
      cfg['pool'] = host ? `${host}:${DEFAULT_STRATUM_PORT}` : undefined;
    }
  }
  // The `webSocket` field was used by the previous web-miner architecture to
  // override the bundled proxy URL. xmrig speaks Stratum directly, so the
  // field is gone from the schema — strip it to avoid leaking unknown keys.
  // 旧構成の webSocket 上書きフィールドは xmrig 直結により不要。古い保存値は黙って除去する。
  if ('webSocket' in cfg) delete cfg['webSocket'];
  next['config'] = cfg;
  return next;
}

/**
 * Extract a usable host from a legacy `pool` value. Older releases let users
 * type either a bare hostname ("moneroocean.stream") or a full URL
 * ("wss://ny1.xmrminingproxy.com:443/path"). The naive split-on-':' approach
 * would turn the URL form into the literal string "wss", silently corrupting
 * upgraded configs — use URL parsing when a scheme is present so the host is
 * preserved correctly.
 * 旧バージョンの pool には URL 形式 (wss://…) も混在する。単純な split では
 * "wss" を host と誤認するため、scheme が付いていれば URL として解釈する。
 */
function extractLegacyHost(input: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(input)) {
    try {
      const url = new URL(input);
      const hostname = url.hostname;
      return hostname || undefined;
    } catch {
      return undefined;
    }
  }
  // Bare hostname (optionally followed by a stray port, path, query, or
  // fragment). Strip anything past the host segment, then drop a trailing
  // port we don't trust (legacy ports were arbitrary, often the WS one).
  // ホスト名のみ。ポート・パス等が混じっていれば落とす。
  const stripped = input.split(/[/?#]/u)[0] ?? '';
  const host = stripped.split(':')[0] ?? '';
  return host || undefined;
}

export class ConfigStore {
  private readonly store: Store<StoreShape>;

  public constructor() {
    this.store = new Store<StoreShape>({
      name: 'desktop-monero-miner',
      defaults: { state: defaultState },
      clearInvalidConfig: true,
    });
  }

  public getState(): PersistedState {
    const raw = this.store.get('state');
    const parsed = persistedStateSchema.safeParse(migrateRawState(raw));
    if (parsed.success) {
      // Persist the migrated form so subsequent writes don't keep stripping
      // the legacy value on every read.
      // 補正後の値を書き戻し、毎回 read のたびに補正が走るのを避ける。
      this.store.set('state', parsed.data);
      return parsed.data;
    }
    this.store.set('state', defaultState);
    return defaultState;
  }

  public getConfig(): PersistedState['config'] {
    return this.getState().config;
  }

  public getPreferences(): AppPreferences {
    return this.getState().preferences;
  }

  public updateConfig(patch: PartialMinerConfig): PersistedState['config'] {
    const current = this.getState();
    const next: PersistedState = {
      ...current,
      config: applyDefined(current.config, patch),
    };
    this.store.set('state', next);
    return next.config;
  }

  public updatePreferences(patch: PartialAppPreferences): AppPreferences {
    const current = this.getState();
    const next: PersistedState = {
      ...current,
      preferences: applyDefined(current.preferences, patch),
    };
    this.store.set('state', next);
    return next.preferences;
  }
}
