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
    if (trimmed && !/^[^:]+:\d+(?::(?:tls|ssl))?$/u.test(trimmed)) {
      // Strip any path/query a user might have pasted, keep only the
      // hostname component, append the standard auto-diff port.
      // パス・クエリは捨ててホスト名だけ取り出し、既定ポートを補う。
      const host = trimmed.split(/[\\/?#]/u)[0]?.split(':')[0] ?? '';
      cfg['pool'] = host ? `${host}:${DEFAULT_STRATUM_PORT}` : undefined;
    }
  }
  next['config'] = cfg;
  return next;
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
