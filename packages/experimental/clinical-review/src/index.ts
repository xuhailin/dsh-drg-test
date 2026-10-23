/** Opt-in encounter review composition: authorized launch, replaceable reads, durable proposals. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Config } from './config.ts'
import { BrokerAccess, HttpEncounterReader } from './reader.ts'
import { ClinicalReviewService } from './state.ts'
import { reviewProjection } from './projection.ts'
import { registerReviewTools } from './tools.ts'
import { registerReviewBridge } from './bridge.ts'
import { ClinicalReviewError } from './error.ts'

export { Config } from './config.ts'
export { ClinicalReviewError } from './error.ts'
export type * from './types.ts'
export const name = 'clinical-review'
export const inject = ['agents', 'sessions', 'sessionProjections', 'sessionPersistence', 'sessionController', 'tools', 'connection']

/** Install advisory review without changing normal chat capabilities.
 * @param ctx - Web runtime services.
 * @param config - Explicit runtime owner, broker routing, and limits.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const access = new BrokerAccess(ctx, config)
  if (config.readerMode === 'http') new HttpEncounterReader(ctx, access)
  else if (ctx.get('encounterReader') === undefined) throw new ClinicalReviewError('reader-unavailable', 'Mount an EncounterReader provider before clinical review.')
  ctx.sessionProjections.register(reviewProjection)
  const attached = new WeakSet<Agent>()
  const review = new ClinicalReviewService(ctx, config, access, attach)
  ctx.provide('clinicalReview', review)
  function attach(agent: Agent): void {
    if (attached.has(agent)) return
    const dispose = registerReviewTools(agent.ctx, agent, review, config)
    ctx.effect(() => dispose, `clinical-review: tools for ${agent.id}`)
    attached.add(agent)
  }
  ctx.on('agent/created', async ({ agent }) => {
    await review.recover(agent)
    const state = ctx.sessionProjections.stateOf(agent.session, 'clinicalReview')
    if (state !== undefined && state !== null && state.ownerSessionId === agent.id
      && state.binding.actorId === config.ownerId) attach(agent)
  })
  for (const agent of ctx.agents.list()) {
    await review.recover(agent)
    const state = ctx.sessionProjections.stateOf(agent.session, 'clinicalReview')
    if (state !== undefined && state !== null && state.ownerSessionId === agent.id
      && state.binding.actorId === config.ownerId) attach(agent)
  }
  registerReviewBridge(ctx, review, config)
}
