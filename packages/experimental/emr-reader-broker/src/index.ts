/** Optional clinical broker mounted only in the authenticated hosted gateway. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-hosted-workspaces'
import { Config } from './config.ts'
import { databaseConfigSchema, PgReadDatabase } from './database.ts'
import { readBoundedFile } from './files.ts'
import { ClinicalBroker } from './http.ts'
import { EncounterPolicy } from './policy.ts'
import { PgEncounterReader } from './reader.ts'
export { Config }
/** Optional clinical runtime plugin identity. */
export const name = 'emr-reader-broker'
/** The generic runtime event supplies identity without service-side token access. */
export const inject: string[] = []
/**
 * Install controlled encounter reads without changing the SSO gateway's business responsibilities.
 * @param ctx - Gateway-owned plugin context.
 * @param config - Validated deployment paths and limits.
 * @returns Completion of secret loading and reversible route registration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const database = databaseConfigSchema.parse(JSON.parse(await readBoundedFile(config.databaseConfigFile, config.maxPolicyBytes)))
  const key = (await readBoundedFile(config.bindingKeyFile, config.maxPolicyBytes)).trim()
  if (key.length < 32) throw new Error('emr-reader-broker: binding key must contain at least 32 characters')
  const policy = new EncounterPolicy(config.allowlistFile, config.maxPolicyBytes, key, config.sourceSystem)
  await policy.validate()
  const reader = new PgEncounterReader(ctx, config, policy, new PgReadDatabase(database, config.requestTimeoutMs))
  const broker = new ClinicalBroker(config, policy, reader)
  ctx.effect(() => () => broker.dispose(), 'emr-reader-broker: clinical requests')
  ctx.on('hosted-workspaces/runtime-request', async (request, next) => await broker.handle(request) || await next())
}
