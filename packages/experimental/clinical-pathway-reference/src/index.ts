/** Optional reference persistence and lightweight preview; all clinical fields use EMR-owned definitions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Config } from './config.ts'
import { configSchema } from './protocol.ts'
import { referenceProjection, sourceProjection } from './projection.ts'
import { ReferenceService } from './state.ts'
import { registerBridge } from './bridge.ts'
import { registerTools } from './tools.ts'

export { Config }
export { lockReference, parseLockReference } from './locks.ts'
export type * from './types.ts'
/** Optional runtime plugin identity. */
export const name = 'clinical-pathway-reference'
/** Durable private Session owner and authenticated preview routing. */
export const inject = ['agents', 'sessions', 'sessionProjections', 'sessionPersistence', 'sessionController', 'tools', 'connection', 'agentPresets']
/**
 * Register reference persistence, projections, tools, and preview routes.
 * @param ctx - Private hosted runtime.
 * @param input - Explicit scope and complete-output bounds.
 */
export function apply(ctx: Context, input: Config): void {
  const config = configSchema.parse(input)
  ctx.sessionProjections.register(referenceProjection)
  ctx.sessionProjections.register(sourceProjection)
  const service = new ReferenceService(ctx, config)
  const attached = new WeakSet<Agent>()
  const attach = (agent: Agent): void => {
    if (!service.ownsPreset(agent) || attached.has(agent)) return
    const dispose = registerTools(agent.ctx, agent, service)
    ctx.effect(() => dispose, `clinical-pathway-reference: ${agent.id}`)
    attached.add(agent)
  }
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  ctx.on('agent-preset/selected', (id) => { const agent = ctx.agents.get(id); if (agent !== undefined) attach(agent) })
  for (const agent of ctx.agents.list()) attach(agent)
  registerBridge(ctx, service)
  ctx.effect(() => () => service.dispose(), 'clinical-pathway-reference: drain saves')
}
