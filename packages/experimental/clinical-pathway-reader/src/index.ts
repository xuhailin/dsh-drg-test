/** Optional pathway reader composes gateway-owned data access with preset-scoped read tools. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-hosted-workspaces'
import { databaseConfigSchema, PgReadDatabase, readBoundedFile } from '@deepseek-ai/dsh-experimental-emr-reader-broker'
import { Config } from './config.ts'
import { PathwayPolicy } from './policy.ts'
import { PathwayGateway } from './gateway.ts'
import { PathwayAccess } from './access.ts'
import { registerPathwayTools } from './tools.ts'

export { Config }
/** Optional composition identity. */
export const name = 'clinical-pathway-reader'
/** Each explicit role validates its own required services before registration. */
export const inject: string[] = []
/**
 * Mount the authenticated gateway provider or the scoped tool consumer.
 * @param ctx - Gateway context or the selected pathway preset's context.
 * @param config - Explicit role, source routing and deployment bounds.
 * @returns Completion after configuration and provider checks succeed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.mode === 'tools') {
    const access = new PathwayAccess(ctx, config)
    ctx.effect(() => () => access.dispose(), 'clinical-pathway-reader: tool requests')
    registerPathwayTools(ctx, access)
    return
  }
  if (!config.databaseConfigFile || !config.policyFile || !config.sourceSystem) throw new Error('clinical-pathway-reader: gateway mode requires databaseConfigFile, policyFile and sourceSystem')
  const database = databaseConfigSchema.parse(JSON.parse(await readBoundedFile(config.databaseConfigFile, config.maxPolicyBytes)))
  const policy = new PathwayPolicy(config.policyFile, config.maxPolicyBytes, config.sourceSystem)
  const gateway = new PathwayGateway(config, config.sourceSystem, new PgReadDatabase(database, config.timeoutMs), policy)
  ctx.effect(() => () => gateway.dispose(), 'clinical-pathway-reader: requests')
  await gateway.validate()
  ctx.on('hosted-workspaces/runtime-request', async (request, next) => await gateway.handle(request) || await next())
}
