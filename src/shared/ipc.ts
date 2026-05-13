import { z } from 'zod';

import {
  appPreferencesSchema,
  minerConfigSchema,
  miningStatsSchema,
  miningStatusSchema,
  partialMinerConfigSchema,
} from './config-schema.ts';

export const IpcChannel = {
  GetConfig: 'config:get',
  SetConfig: 'config:set',
  GetPreferences: 'prefs:get',
  SetPreferences: 'prefs:set',
  StartMining: 'mining:start',
  StopMining: 'mining:stop',
  GetMiningStatus: 'mining:status',
  ReportStats: 'mining:stats',
  OpenExternal: 'shell:open-external',
  AppVersion: 'app:version',
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];

export const startMiningPayloadSchema = z.object({
  config: minerConfigSchema,
});
export type StartMiningPayload = z.infer<typeof startMiningPayloadSchema>;

export const setConfigPayloadSchema = z.object({
  patch: partialMinerConfigSchema,
});
export type SetConfigPayload = z.infer<typeof setConfigPayloadSchema>;

export const setPreferencesPayloadSchema = z.object({
  patch: appPreferencesSchema.partial(),
});
export type SetPreferencesPayload = z.infer<typeof setPreferencesPayloadSchema>;

/**
 * Allowlist for `shell.openExternal`. We deliberately reject `file:`, `javascript:`,
 * `mailto:` and any custom protocol handlers — only HTTP(S) is forwarded to the OS.
 * `shell.openExternal` の許可スキーム。`file:` や独自プロトコル経由でのハンドラ起動を防ぐため
 * HTTP(S) のみを許可します。
 */
export const ALLOWED_EXTERNAL_PROTOCOLS = ['https:', 'http:'] as const;

function isAllowedExternalUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (ALLOWED_EXTERNAL_PROTOCOLS as readonly string[]).includes(parsed.protocol);
  } catch {
    return false;
  }
}

export const openExternalPayloadSchema = z.object({
  url: z
    .string()
    .url()
    .refine(isAllowedExternalUrl, { message: 'external_url_protocol_not_allowed' }),
});
export type OpenExternalPayload = z.infer<typeof openExternalPayloadSchema>;

export function isSafeExternalUrl(value: string): boolean {
  return isAllowedExternalUrl(value);
}

export const miningStateUpdateSchema = z.object({
  status: miningStatusSchema,
  stats: miningStatsSchema.optional(),
  message: z.string().optional(),
});
export type MiningStateUpdate = z.infer<typeof miningStateUpdateSchema>;
