/** Authenticated public configuration for the optional clinical-result viewer. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ViewerConfig } from './types.ts'

/** Deployment-owned embedding origins and browser request bounds. */
export type Config = ViewerConfig
/** Validate public settings without accepting credentials or clinical content. */
export const Config: z<Partial<Config>, Config> = z.object({
  allowedOrigins: z.array(String).default([]),
  requestTimeoutMs: z.natural().min(1).max(2147483647).default(30000),
  maxMessageBytes: z.natural().min(1).default(8192),
  maxPendingRequests: z.natural().min(1).max(32).default(4),
  maxActionReceipts: z.natural().min(1).default(256),
  directoryPageSize: z.natural().min(1).max(1000).default(20),
})
/** Owner-authenticated HTTP route registry. */
export const inject = ['connection']
/**
 * Publish validated public viewer settings for this profile.
 * @param ctx - authenticated connection and plugin lifetime.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config): void {
  for (const origin of config.allowedOrigins) {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
      throw new Error('client-clinical-results: allowedOrigins requires exact HTTP(S) origins without paths')
    }
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/clinical-results/config', methods: ['GET'], requestBody: 'buffered',
    fetch: () => Promise.resolve(Response.json(config, { headers: { 'cache-control': 'no-store' } })),
  }))
}
