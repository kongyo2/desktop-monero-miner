import Store from 'electron-store';

import {
  type AppPreferences,
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
    const parsed = persistedStateSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
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
