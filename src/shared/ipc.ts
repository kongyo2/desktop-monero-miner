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

export const openExternalPayloadSchema = z.object({
  url: z.string().url(),
});
export type OpenExternalPayload = z.infer<typeof openExternalPayloadSchema>;

export const miningStateUpdateSchema = z.object({
  status: miningStatusSchema,
  stats: miningStatsSchema.optional(),
  message: z.string().optional(),
});
export type MiningStateUpdate = z.infer<typeof miningStateUpdateSchema>;
