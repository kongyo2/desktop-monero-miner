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

const wsUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith('ws://') || value.startsWith('wss://'), {
    message: 'websocket_url_invalid_scheme',
  })
  .refine(
    (value) => {
      // WebSocket URLs with a fragment are not addressable and break at connect time.
      // フラグメント付きの WebSocket URL は接続時に失敗するため事前に弾く。
      try {
        return new URL(value).hash === '';
      } catch {
        return false;
      }
    },
    { message: 'websocket_url_fragment_not_allowed' },
  );

export const minerConfigSchema = z.object({
  walletAddress: moneroAddressSchema,
  workerId: z.string().trim().min(1).max(64).default('Desktop-Miner'),
  pool: z.string().trim().min(1).default('moneroocean.stream'),
  webSocket: wsUrlSchema.default('wss://ny1.xmrminingproxy.com'),
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
