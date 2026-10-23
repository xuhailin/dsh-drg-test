import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { appendPluginRecord, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { parseBinding, parseSnapshot, type LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { ClinicalReviewService } from '../src/state.ts'
import { reviewProjection } from '../src/projection.ts'
import type { Config } from '../src/config.ts'
import type { ReviewState } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const config: Config = { brokerBaseUrl: 'http://gateway/runtime/emr/', runtimeTokenEnv: 'TEST_CLINICAL_TOKEN', ownerId: 'actor-a', cwd: '/tmp',
  timeoutMs: 10_000, maxResponseBytes: 1024 * 1024, maxToolBytes: 65536, maxSourceChars: 12000, maxFindings: 20,
  maxOperations: 50, maxReports: 20,
  maxRequestBytes: 65536, maxStateBytes: 2 * 1024 * 1024, maxInventoryItems: 20, readerMode: 'http', reviewLanguage: 'zh-CN' }
const claim: LaunchClaim = { eventId: 'opened', trigger: 'open', sourceSystem: 'emr', hospitalCode: '1001', inpatId: '123' }
const binding = parseBinding({ schemaVersion: 1, bindingId: '11111111-1111-4111-8111-111111111111', actorId: 'actor-a', actorIssuer: 'https://issuer.example', actorSubject: 'doctor-a', sourceSystem: 'emr', hospitalCode: '1001', inpatId: '123' })
function snapshot(content = 'Diagnosis: pneumonia. Discharge summary: pneumonia.') {
  const digest = createHash('sha256').update(content).digest('hex')
  return parseSnapshot({ schemaVersion: 1, bindingId: binding.bindingId, caseRevision: digest, providerRevision: 'emr-pg-v1',
    capturedAt: '2026-10-22T00:00:00.000Z', cutoff: '2026-10-22T00:00:00.000Z',
    sources: [{ sourceRef: 'source-document-1', category: 'documents', sourceId: 'document-1', sourceRevision: digest, state: 'signed', content, contentDigest: digest }],
    coverage: ['encounter', 'diagnoses', 'orders', 'documents', 'labs', 'checks', 'operations', 'administration'].map(category => ({ category, status: category === 'documents' ? 'complete' : 'unsupported' })) })
}

async function setup(overrides: Partial<Config> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(reviewProjection)
  const capture = vi.fn(async () => snapshot())
  ctx.provide('encounterReader', { capture })
  ctx.provide('sessionPersistence', { stat: async () => undefined })
  const followup = vi.fn<Agent['followup']>()
  const makeAgent = async (id: ReturnType<typeof SessionId>, seed?: readonly SessionEvent[]) => {
    const scope = ctx.plugin(() => {})
    const session = ctx.sessions.create(id, seed === undefined ? undefined : { seed, meta: { parentSession: SessionId('original'), isSeeded: true }, inheritedEventCount: SessionLogOffset(seed.length) })
    const agent: Agent = { id, options: {}, session, status: 'idle', ctx: scope.ctx, inbox: unsupportedInbox(),
      followup, steer: () => {}, inject: () => {}, send: () => {}, cancel: () => {}, whenIdle: () => Promise.resolve(),
      runMaintenance: task => task(new AbortController().signal) }
    await ctx.agents.register(agent)
    return agent
  }
  ctx.provide('sessionController', {
    create: async ({ sessionId }: { sessionId: ReturnType<typeof SessionId> }) => { await makeAgent(sessionId); return { sessionId } },
    resolveAgent: async (id: ReturnType<typeof SessionId>) => { const agent = ctx.agents.get(id); return agent === undefined ? { error: new Error('missing') } : { agent } },
  })
  const flush = vi.fn(async () => {})
  ctx.on('session/flush', flush, { global: true })
  const access = { authorize: vi.fn(async () => binding) }
  const attach = vi.fn()
  const review = new ClinicalReviewService(ctx, Object.assign({}, config, overrides), access, attach)
  const opened = await review.launch(claim, new AbortController().signal)
  const agent = ctx.agents.get(opened.sessionId)
  if (agent === undefined) throw new Error('missing agent')
  const signal = new AbortController().signal
  const start = async (eventId = 'review-1') => {
    const receipt = await review.trigger(agent.id, eventId, 'manual-review', signal)
    await expect.poll(() => review.require(agent).status).toBe('reviewing')
    return receipt
  }
  return { ctx, review, agent, followup, capture, access, attach, flush, start, signal, makeAgent, opened }
}

describe('encounter review admission and durable state', () => {
  it('opening only binds metadata; duplicate review events wake once and return before the reader completes', async () => {
    const fixture = await setup()
    const { review, agent, followup, capture, signal } = fixture
    expect(capture).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
    let release!: () => void
    const ready = new Promise<void>((resolve) => { release = resolve })
    capture.mockImplementationOnce(async () => { await ready; return snapshot() })
    expect(await review.trigger(agent.id, 'event-1', 'discharge-order', signal)).toMatchObject({ status: 'accepted', dischargeBlocked: false })
    expect(await review.trigger(agent.id, 'event-1', 'discharge-order', signal)).toMatchObject({ status: 'duplicate', revision: 1 })
    expect(followup).not.toHaveBeenCalled()
    release()
    await expect.poll(() => vi.mocked(followup).mock.calls.length).toBe(1)
    expect(await review.launch(claim, signal)).toMatchObject({ sessionId: agent.id, status: 'bound' })
  })

  it('requires exact read quotations and leaves all saved findings pending human review', async () => {
    const { review, agent, start, signal } = await setup()
    await start()
    const current = snapshot()
    const proposal = { revision: 1, caseRevision: current.caseRevision, summary: 'Verify the source documentation.', reviewedSourceRefs: ['source-document-1'],
      findings: [{ kind: 'needs-verification' as const, title: 'Verify wording', explanation: 'A clinician should assess this wording.', suggestion: 'Review the original document.',
        citations: [{ sourceRef: 'source-document-1', start: 0, end: 9, quote: 'Diagnosis' }] }] }
    await expect(review.submit(agent, proposal, signal)).rejects.toMatchObject({ code: 'unread-source' })
    await review.read(agent, 1, 'source-document-1', 0, 12000, signal)
    await expect(review.submit(agent, { ...proposal, findings: [{ ...proposal.findings[0]!, citations: [{ sourceRef: 'other', start: 0, end: 9, quote: 'Diagnosis' }] }] }, signal)).rejects.toMatchObject({ code: 'invalid-citation' })
    const text = await review.submit(agent, proposal, signal)
    expect(JSON.parse(text)).toMatchObject({ status: 'reviewed', report: { assessment: 'pending-human-review' }, calculation: { drg: 'unavailable', dip: 'unavailable' }, dischargeBlocked: false })
    expect(review.require(agent).report?.findings).toHaveLength(1)
  })

  it('locates unread sources and invalid citations without repeating clinical text or unknown references', async () => {
    const { review, agent, start, signal } = await setup()
    await start()
    const proposal = { revision: 1, caseRevision: snapshot().caseRevision, summary: 'Review proposal.', findings: [], reviewedSourceRefs: ['source-document-1'] }
    await expect(review.submit(agent, proposal, signal)).rejects.toThrowErrorMatchingInlineSnapshot(
      '[ClinicalReviewError: Source source-document-1 at reviewedSourceRefs[0] has not been fully read. Read its complete original content or remove it from reviewedSourceRefs. Partial citations still require exact text already read from the snapshot.]',
    )
    await expect(review.submit(agent, { ...proposal, reviewedSourceRefs: ['UNKNOWN_PRIVATE_TEXT'] }, signal)).rejects.toThrowErrorMatchingInlineSnapshot(
      '[ClinicalReviewError: reviewedSourceRefs[0] is not in this Session snapshot. Remove it from reviewedSourceRefs. Partial citations still require exact text already read from the snapshot.]',
    )
    const findings = [{ kind: 'inconsistency' as const, title: 'Verify source',
      explanation: 'Check source text.', suggestion: 'Review the original.',
      citations: [{ sourceRef: 'source-document-1', start: 0, end: 9, quote: 'PRIVATE_CLINICAL_TEXT' }] }]
    await expect(review.submit(agent, { ...proposal, reviewedSourceRefs: [], findings }, signal))
      .rejects.toThrowErrorMatchingInlineSnapshot(
        '[ClinicalReviewError: Citation findings[0].citations[0] for source source-document-1 must reference a source in this Session snapshot and quote exact text within offsets already read. Correct the source, offsets, and quotation, or read the required passage first.]',
      )
    await expect(review.submit(agent, { ...proposal, reviewedSourceRefs: [], findings: [{ ...findings[0]!,
      citations: [{ ...findings[0]!.citations[0]!, sourceRef: 'UNKNOWN_PRIVATE_TEXT' }] }] }, signal)).rejects.toThrowErrorMatchingInlineSnapshot(
      '[ClinicalReviewError: Citation findings[0].citations[0] must reference a source in this Session snapshot and quote exact text within offsets already read. Correct the source, offsets, and quotation, or read the required passage first.]',
    )
    expect(review.require(agent).report).toBeNull()
    await review.read(agent, 1, 'source-document-1', 0, 9, signal)
    const repaired = [{ ...findings[0]!, citations: [{ sourceRef: 'source-document-1', start: 0, end: 9, quote: 'Diagnosis' }] }]
    await expect(review.submit(agent, { ...proposal, reviewedSourceRefs: [], findings: repaired }, signal)).resolves.toContain('pending-human-review')
  })

  it('refresh invalidates accepted findings and rejects older model proposals', async () => {
    const { review, agent, followup, start, signal } = await setup()
    await start()
    await review.submit(agent, { revision: 1, caseRevision: snapshot().caseRevision, summary: 'Documents require further review.', findings: [], reviewedSourceRefs: [] }, signal)
    await review.trigger(agent.id, 'refresh-2', 'refresh', signal)
    await expect.poll(() => review.require(agent).status).toBe('stale')
    expect(review.require(agent)).toMatchObject({ revision: 2, report: null })
    expect(review.require(agent).history).toHaveLength(1)
    await expect(review.read(agent, 1, 'source-document-1', 0, 10, signal)).rejects.toMatchObject({ code: 'stale-revision' })
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('reauthorizes reads and stops on changed evidence or broker denial', async () => {
    const { review, agent, start, capture, signal } = await setup()
    await start()
    capture.mockResolvedValueOnce(snapshot('Changed document'))
    await expect(review.load(agent, signal)).rejects.toMatchObject({ code: 'stale-evidence' })
    expect(review.require(agent).status).toBe('stale')
    capture.mockRejectedValueOnce(new Error('denied'))
    await expect(review.load(agent, signal)).rejects.toThrow('denied')
  })

  it('keeps an unknown flush outcome from waking the model or permitting dependent reads', async () => {
    const { review, agent, followup, flush, signal, capture } = await setup()
    flush.mockRejectedValueOnce(new Error('writer failed'))
    await expect(review.trigger(agent.id, 'failed-flush', 'manual-review', signal)).rejects.toMatchObject({ code: 'durability-unknown' })
    expect(followup).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    await expect(review.load(agent, signal)).rejects.toMatchObject({ code: 'durability-unknown' })
    expect(await review.status(agent.id)).toMatchObject({ durability: 'unknown', dischargeBlocked: false })
  })

  it('does not turn inherited Session records into encounter authority', async () => {
    const { review, agent, makeAgent, signal } = await setup()
    const child = await makeAgent(SessionId('forked'))
    const state: ReviewState = review.require(agent)
    appendPluginRecord(child.session, 'plugin:clinical-review/state', state)
    await expect(review.load(child, signal)).rejects.toMatchObject({ code: 'inherited-binding' })
  })

  it('a late superseded capture never overwrites the newer revision or wakes a second turn', async () => {
    const { review, agent, followup, capture, signal } = await setup()
    let release!: () => void
    const ready = new Promise<void>((resolve) => { release = resolve })
    capture.mockImplementationOnce(async () => { await ready; return snapshot('Old source') })
    await review.trigger(agent.id, 'old', 'manual-review', signal)
    await review.trigger(agent.id, 'new', 'manual-review', signal)
    await expect.poll(() => review.require(agent).status).toBe('reviewing')
    release()
    await expect.poll(() => review.require(agent).operations.find(operation => operation.eventId === 'old')?.status).toBe('cancelled')
    expect(review.require(agent).revision).toBe(2)
    expect(review.require(agent).snapshot?.caseRevision).toBe(snapshot().caseRevision)
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('rejects a complete tool result above its byte limit without recording unread ranges', async () => {
    const { review, agent, start, signal } = await setup({ maxToolBytes: 30 })
    await start()
    await expect(review.read(agent, 1, 'source-document-1', 0, 10, signal)).rejects.toMatchObject({ code: 'limit-exceeded' })
    expect(review.require(agent).readRanges).toEqual([])
  })
  it('rejects oversized report JSON before appending and leaves replay usable', async () => {
    const { review, agent, start, signal } = await setup()
    await start()
    await expect(review.submit(agent, { revision: 1, caseRevision: snapshot().caseRevision, summary: 'x'.repeat(8001), findings: [], reviewedSourceRefs: [] }, signal))
      .rejects.toMatchObject({ code: 'invalid-proposal' })
    expect(JSON.parse(await review.load(agent, signal))).toMatchObject({ revision: 1 })
    expect(review.require(agent).report).toBeNull()
  })

  it('status returns progress without source material or unverified report text', async () => {
    const { review, agent, start, signal, capture } = await setup()
    await start()
    await review.submit(agent, { revision: 1, caseRevision: snapshot().caseRevision, summary: 'Private clinical report.', findings: [], reviewedSourceRefs: [] }, signal)
    capture.mockRejectedValue(new Error('authorization revoked'))
    const status = await review.status(agent.id)
    expect(status).toMatchObject({ status: 'reviewed', reportAvailable: true, dischargeBlocked: false })
    expect(JSON.stringify(status)).not.toMatch(/Private clinical|coverage|sourceRef|cutoff/)
    await expect(review.report(agent, signal)).rejects.toThrow('authorization revoked')
  })

  it('resumed incomplete work becomes interrupted without redispatch, and accepts a new explicit event', async () => {
    const { review, agent, followup, signal } = await setup()
    appendPluginRecord(agent.session, 'plugin:clinical-review/state', { ...review.require(agent), status: 'collecting', revision: 1,
      operations: [{ eventId: 'interrupted-event', trigger: 'manual-review', status: 'accepted', revision: 1 }] })
    await review.recover(agent)
    expect(review.require(agent)).toMatchObject({ status: 'failed', operations: [{ status: 'failed', errorCode: 'interrupted' }] })
    expect(followup).not.toHaveBeenCalled()
    expect(await review.trigger(agent.id, 'interrupted-event', 'manual-review', signal)).toMatchObject({ status: 'duplicate' })
    expect(await review.trigger(agent.id, 'new-explicit-event', 'manual-review', signal)).toMatchObject({ status: 'accepted', revision: 2 })
    await expect.poll(() => review.require(agent).status).toBe('reviewing')
    expect(followup).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(followup).mock.calls)).toContain('zh-CN')
  })

  it('same encounter reauthorization replaces an old binding and invalidates its evidence', async () => {
    const { review, agent, start, signal, access } = await setup()
    await start()
    await review.submit(agent, { revision: 1, caseRevision: snapshot().caseRevision, summary: 'Old proposal.', findings: [], reviewedSourceRefs: [] }, signal)
    const replacement = parseBinding({ ...binding, bindingId: '22222222-2222-4222-8222-222222222222' })
    access.authorize.mockResolvedValueOnce(replacement)
    await review.launch(claim, signal)
    expect(review.require(agent)).toMatchObject({ binding: replacement, revision: 2, status: 'bound', snapshot: null, report: null, readRanges: [] })
    expect(review.require(agent).history).toHaveLength(1)
    await expect(review.load(agent, signal)).rejects.toMatchObject({ code: 'snapshot-unavailable' })
  })

  it.each([
    { reason: 'completed' as const, errorCode: 'report-not-submitted' },
    { reason: 'max-tokens' as const, errorCode: 'model-turn-max-tokens' },
  ])('marks a $reason clinical turn without a submitted report as failed until explicit retry', async ({ reason, errorCode }) => {
    const { review, agent, start, followup, capture, flush } = await setup()
    await start()
    const message = followup.mock.calls[0]?.[0]
    if (message === undefined) throw new Error('missing review trigger')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    const reads = capture.mock.calls.length
    const flushes = flush.mock.calls.length
    agent.session.append('turn/end', { turn: 1, reason: { kind: reason } })
    await expect.poll(async () => review.status(agent.id)).toMatchObject({ status: 'failed', reportAvailable: false,
      operations: [{ status: 'failed', errorCode }], dischargeBlocked: false })
    expect(flush.mock.calls.length).toBeGreaterThan(flushes)
    expect(capture).toHaveBeenCalledTimes(reads)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(await start('explicit-retry')).toMatchObject({ status: 'accepted', revision: 2 })
    expect(followup).toHaveBeenCalledTimes(2)
  })

  it('does not close a queued review when an unrelated turn ends or a newer review supersedes it', async () => {
    const { review, agent, start, followup, signal } = await setup()
    await start()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Unrelated chat' }] }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect((await review.status(agent.id))).toMatchObject({ status: 'reviewing' })
    const message = followup.mock.calls[0]?.[0]
    if (message === undefined) throw new Error('missing review trigger')
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    await review.trigger(agent.id, 'new-review', 'manual-review', signal)
    await expect.poll(() => review.require(agent).status).toBe('reviewing')
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await review.status(agent.id)
    expect(review.require(agent)).toMatchObject({ revision: 2, status: 'reviewing' })
  })

  it('keeps a submitted report when its clinical turn ends', async () => {
    const { review, agent, start, followup, signal } = await setup()
    await start()
    const message = followup.mock.calls[0]?.[0]
    if (message === undefined) throw new Error('missing review trigger')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    await review.submit(agent, { revision: 1, caseRevision: snapshot().caseRevision, summary: 'Review proposal.', findings: [], reviewedSourceRefs: [] }, signal)
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(await review.status(agent.id)).toMatchObject({ status: 'reviewed', reportAvailable: true })
  })

})
