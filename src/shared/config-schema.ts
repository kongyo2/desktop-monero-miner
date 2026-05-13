import { z } from 'zod';

/**
 * Monero wallet addresses commonly start with 4 (main address) or 8 (subaddress).
 * The standard public address length is exactly 95 base58 characters; integrated addresses are exactly 106.
 * モネロのウォレットアドレスは通常「4」または「8」で始まり、95 文字（標準）か 106 文字（統合）の固定長です。
 */
const MONERO_ADDRESS_LENGTHS = new Set([95, 106]);

export const moneroAddressSchema = z
  .string()
  .trim()
  .regex(/^[48][1-9A-HJ-NP-Za-km-z]+$/u, { message: 'wallet_address_invalid' })
  .refine((value) => MONERO_ADDRESS_LENGTHS.has(value.length), {
    message: 'wallet_address_invalid_length',
  });

export const localeSchema = z.enum(['ja', 'en']);
export type Locale = z.infer<typeof localeSchema>;

/**
 * moneroocean.stream's auto-diff plain-TCP port. Used as both the default for
 * fresh configs and the fallback port when migrating bare-hostname pool values
 * persisted by pre-proxy releases of the app.
 * 既定ポート（moneroocean.stream の auto-diff）。新規設定の既定値と、旧バージョンの
 * ホスト名のみの pool 値を補正する際の代替ポートを兼ねる。
 */
export const DEFAULT_STRATUM_PORT = 10128;

/**
 * Stratum endpoint accepted by xmrig. Format is "host:port" or "host:port:tls".
 * The bundled runner passes this directly to xmrig via `-o host:port`, adding
 * `--tls` when the third token is "tls"/"ssl".
 * xmrig に渡す Stratum エンドポイント。"host:port" または "host:port:tls" を受理する。
 */
const stratumEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      const parts = value.split(':');
      if (parts.length < 2 || parts.length > 3) return false;
      const [host, portStr, flag] = parts;
      if (!host || !portStr) return false;
      const port = Number(portStr);
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) return false;
      if (flag !== undefined && flag !== '' && flag !== 'tls' && flag !== 'ssl') return false;
      return true;
    },
    { message: 'pool_endpoint_invalid' },
  );

export const minerConfigSchema = z.object({
  walletAddress: moneroAddressSchema,
  workerId: z.string().trim().min(1).max(64).default('Desktop-Miner'),
  // Default pool: gulf.moneroocean.stream over plain TCP on the auto-diff port.
  // xmrig handles the RandomX algorithm natively; the proxy translation layer
  // that the previous web-miner approach required is no longer needed.
  // 既定プール: moneroocean.stream の auto-diff ポート。xmrig が RandomX を直接処理する。
  pool: stratumEndpointSchema.default(`gulf.moneroocean.stream:${DEFAULT_STRATUM_PORT}`),
  threads: z.number().int().min(1).max(256).default(2),
  throttle: z.number().int().min(0).max(99).default(20),
  password: z.string().default(''),
});

export type MinerConfig = z.infer<typeof minerConfigSchema>;

export const partialMinerConfigSchema = minerConfigSchema.partial();
export type PartialMinerConfig = z.infer<typeof partialMinerConfigSchema>;

export const appPreferencesSchema = z.object({
  locale: localeSchema.default('ja'),
  autoStart: z.boolean().default(false),
});

export type AppPreferences = z.infer<typeof appPreferencesSchema>;

export const partialAppPreferencesSchema = appPreferencesSchema.partial();
export type PartialAppPreferences = z.infer<typeof partialAppPreferencesSchema>;

export const persistedStateSchema = z.object({
  config: minerConfigSchema.partial().default({}),
  preferences: appPreferencesSchema.default({ locale: 'ja', autoStart: false }),
});

export type PersistedState = z.infer<typeof persistedStateSchema>;

export const miningStatusSchema = z.enum(['idle', 'starting', 'running', 'stopping', 'error']);
export type MiningStatus = z.infer<typeof miningStatusSchema>;

export const miningStatsSchema = z.object({
  hashrate: z.number().nonnegative().default(0),
  acceptedShares: z.number().int().nonnegative().default(0),
  rejectedShares: z.number().int().nonnegative().default(0),
  totalHashes: z.number().nonnegative().default(0),
  uptimeSec: z.number().nonnegative().default(0),
});

export type MiningStats = z.infer<typeof miningStatsSchema>;
