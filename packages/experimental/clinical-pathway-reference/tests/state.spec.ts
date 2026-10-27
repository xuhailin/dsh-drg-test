import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { readDefinition } from '../src/emr/definition-reader.ts'
import { ReferenceService } from '../src/state.ts'
import { referenceProjection } from '../src/projection.ts'
import type { ReferenceConfig, ReferenceState, ReferenceView } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const config: ReferenceConfig = { scope: { sourceSystem: 'emr', hospitalCode: '1001', departmentCodes: ['99999'], departmentBasis: 'current',
  admissionFrom: '2025-10-27T00:00:00Z', admissionTo: '2026-10-27T00:00:00Z' }, maxRevisions: 20, maxStateBytes: 1024 * 1024, maxRequestBytes: 1024 * 1024 }
function current(view: ReferenceView) { if (view.state === null) throw new Error('missing state'); return view.state.revisions.at(-1)! }
async function setup(overrides: Partial<ReferenceConfig> = {}) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(agentPresetProjectionDefinition); ctx.sessionProjections.register(referenceProjection)
  const flush = vi.fn(async () => {})
  ctx.on('session/flush', flush, { global: true })
  const makeAgent = async (name: string, preset = 'clinical-pathway-analysis', seed?: readonly SessionEvent[], fork = false) => {
    const id = SessionId(name), scope = ctx.plugin(() => {})
    const session = ctx.sessions.create(id, { meta: { agentPreset: preset, ...(fork ? { parentSession: SessionId('owner'), isSeeded: true } : {}) },
      ...(seed === undefined ? {} : { seed }), ...(fork ? { inheritedEventCount: SessionLogOffset(seed?.length ?? 0) } : {}) })
    const agent: Agent = { id, options: {}, session, status: 'idle', ctx: scope.ctx, inbox: unsupportedInbox(),
      followup: vi.fn(), steer() {}, inject() {}, send() {}, cancel() {}, whenIdle: async () => {},
      runMaintenance: task => task(new AbortController().signal) }
    await ctx.agents.register(agent)
    return agent
  }
  ctx.provide('sessionController', { resolveAgent: async (id: SessionId) => { const agent = ctx.agents.get(id); return agent === undefined ? { error: new Error('missing') } : { agent } } })
  const service = new ReferenceService(ctx, { ...config, ...overrides })
  const agent = await makeAgent('owner')
  const create = () => service.create({ sessionId: agent.id, requestId: 'create', mode: 'new', title: 'Synthetic reference', scope: config.scope })
  return { ctx, service, agent, makeAgent, create, flush }
}
describe('confirmed private reference revisions', () => {
  it('saves one idempotent task, restores the same payload, denies forks and ordinary presets', async () => {
    const { ctx, service, agent, makeAgent, create, flush } = await setup()
    const saved = await create()
    expect(await create()).toEqual(saved)
    expect(flush).toHaveBeenCalledTimes(1)
    let replay: ReferenceState | null = referenceProjection.init()
    for (const event of agent.session.snapshotEvents()) replay = referenceProjection.apply(replay, event)
    expect(replay).toEqual(saved.state)
    await expect(new ReferenceService(ctx, config).read(agent.id)).resolves.toEqual(saved)
    const fork = await makeAgent('fork', 'clinical-pathway-analysis', agent.session.snapshotEvents(), true)
    await expect(service.read(fork.id)).rejects.toMatchObject({ code: 'forbidden' })
    const ordinary = await makeAgent('ordinary', 'standard')
    await expect(service.read(ordinary.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(service.create({ sessionId: agent.id, requestId: 'create', mode: 'new', title: 'Changed request', scope: config.scope })).rejects.toMatchObject({ code: 'conflict' })
  })
  it('merges independent stale fields, rejects overlaps, and undoes one change without erasing later fields', async () => {
    const { service, agent, create } = await setup()
    const initial = current(await create()).definition
    const changedName = readDefinition({ ...initial, clinicalPathway: { ...initial.clinicalPathway, name: 'Draft name' } })
    await service.commit({ sessionId: agent.id, requestId: 'name', baseRevision: 1, definition: changedName })
    const changedDescription = readDefinition({ ...initial, clinicalPathway: { ...initial.clinicalPathway, description: 'Independent note' } })
    const merged = current(await service.commit({ sessionId: agent.id, requestId: 'note', baseRevision: 1, definition: changedDescription }))
    expect(merged.definition.clinicalPathway).toMatchObject({ name: 'Draft name', description: 'Independent note' })
    await expect(service.commit({ sessionId: agent.id, requestId: 'overlap', baseRevision: 1, definition: readDefinition({ ...initial, clinicalPathway: { ...initial.clinicalPathway, name: 'Other name' } }) })).rejects.toThrow('conflict')
    const undone = current(await service.undo({ sessionId: agent.id, requestId: 'undo-name', baseRevision: 3, revision: 2 }))
    expect(undone.definition.clinicalPathway).toMatchObject({ name: null, description: 'Independent note' })
    expect(undone.undoes).toBe(2)
    await expect(service.undo({ sessionId: agent.id, requestId: 'again', baseRevision: 4, revision: 2 })).rejects.toMatchObject({ code: 'conflict' })
  })
  it('preserves user locks and rejects model lock replacement, invalid candidates and retained-state overflow atomically', async () => {
    const { service, agent, create } = await setup({ maxRevisions: 3 })
    const initial = current(await create()).definition, key = initial.clinicalPathway.localId
    const locked = current(await service.commit({ sessionId: agent.id, requestId: 'lock', baseRevision: 1, definition: initial, locks: [`${key}#name`] }))
    await expect(service.undo({ sessionId: agent.id, requestId: 'undo-user-lock', baseRevision: 2, revision: 2 }, true)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(service.commit({ sessionId: agent.id, requestId: 'unlock-model', baseRevision: 2, definition: initial, locks: [] }, true)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(service.commit({ sessionId: agent.id, requestId: 'change-locked', baseRevision: 2,
      definition: readDefinition({ ...initial, clinicalPathway: { ...initial.clinicalPathway, name: 'Blocked' } }) })).rejects.toThrow('conflict')
    expect(current(await service.read(agent.id))).toEqual(locked)
    await service.commit({ sessionId: agent.id, requestId: 'unlock-user', baseRevision: 2, definition: initial, locks: [] })
    await expect(service.commit({ sessionId: agent.id, requestId: 'full', baseRevision: 3, definition: initial })).rejects.toMatchObject({ code: 'limit-exceeded' })
    expect(current(await service.read(agent.id)).revision).toBe(3)
  })
  it('queues reads behind durability and blocks unknown outcomes until replay', async () => {
    const { service, agent, create, flush, ctx } = await setup()
    let release!: () => void
    flush.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const saving = create()
    await vi.waitFor(() =>{  expect(flush).toHaveBeenCalledOnce() })
    let observed = false
    const read = service.read(agent.id).then((value) => { observed = true; return value })
    await Promise.resolve(); expect(observed).toBe(false)
    release(); await saving; expect((await read).state).not.toBeNull()
    flush.mockRejectedValueOnce(new Error('disk unavailable'))
    const definition = current(await service.read(agent.id)).definition
    await expect(service.commit({ sessionId: agent.id, requestId: 'unknown', baseRevision: 1, definition })).rejects.toMatchObject({ code: 'durability-unknown' })
    await expect(service.read(agent.id)).rejects.toMatchObject({ code: 'durability-unknown' })
    flush.mockRejectedValueOnce(new Error('disk still unavailable after plugin reload'))
    await expect(new ReferenceService(ctx, config).read(agent.id)).rejects.toMatchObject({ code: 'durability-unknown' })
    expect(current(await new ReferenceService(ctx, config).read(agent.id)).revision).toBe(2)
  })
  it('rejects revision mode without exact source evidence and a mismatched scope', async () => {
    const { service, agent } = await setup()
    await expect(service.create({ sessionId: agent.id, requestId: 'missing', mode: 'revision', title: 'Revision', scope: config.scope, sourceEventSeq: 12 })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(service.create({ sessionId: agent.id, requestId: 'wrong-scope', mode: 'new', title: 'Wrong scope', scope: { ...config.scope, hospitalCode: 'other' } })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await service.read(agent.id)).state).toBeNull()
  })
})
