/** Authenticated public settings for the optional EMR browser entry. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { EntryConfig } from './types.ts'

/** Deployment-owned browser origins, defaults, and request limits. */
export type Config = EntryConfig
/** Runtime validation for public EMR entry settings. */
export const Config: z<Partial<Config>, Config> = z.object({
  allowedOrigins: z.array(String).default([]),
  defaultSourceSystem: z.string().pattern(/^[^\p{Cc}]{1,512}$/u).required(),
  defaultHospitalCode: z.string().pattern(/^[^\p{Cc}]{1,512}$/u).required(),
  requestTimeoutMs: z.natural().min(1).max(2147483647).default(30000),
  maxPendingRequests: z.natural().min(1).max(32).default(4),
  maxMessageBytes: z.natural().min(1).default(8192),
})
/** Required authenticated HTTP route registry. */
export const inject = ['connection']
/**
 * Publish deployment settings through the existing owner-authenticated channel.
 * @param ctx - Host connection and plugin lifetime.
 * @param config - validated public entry settings.
 */
export function apply(ctx: Context, config: Config): void {
  for (const origin of config.allowedOrigins) {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
      throw new Error('client-emr-entry: allowedOrigins requires exact HTTP(S) origins without paths')
    }
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/emr-entry/config', methods: ['GET'], requestBody: 'buffered',
    fetch: () => Promise.resolve(Response.json(config, { headers: { 'cache-control': 'no-store' } })),
  }))
}
