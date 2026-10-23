/** Per-Session encounter authority, immutable snapshots, and durable review admission. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { EncounterBinding, EncounterSnapshot, LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Config } from './config.ts'
import { proposalSchema } from './projection.ts'
import { ClinicalReviewError } from './error.ts'
import type { ReviewLaunchAccess } from './reader.ts'
import type { ReviewFinding, ReviewOperation, ReviewReceipt, ReviewReport, ReviewReportId, ReviewState } from './types.ts'
import { resultIdForSession, type ClinicalEncounterRef, type ClinicalFindingId, type ResultRequest, type ResultsRequest, type RerunRequest,
  type ResultResponse, type ResultsResponse, type ResultSummary, type RerunResponse } from './result.ts'
import type { RetainedReviewReport } from './result-projection.ts'

declare module '@deepseek-ai/cordis' { interface Context { clinicalReview: ClinicalReviewService } }

/** Complete report proposal validated at the tool's JSON boundary. */
export interface SubmitFindings {
  readonly revision: number
  readonly caseRevision: string
  readonly summary: string
  readonly findings: readonly ReviewFinding[]
  readonly reviewedSourceRefs: readonly string[]
}

/** Coordinates existing DSH Agents without adding a clinical agent loop. */
export class ClinicalReviewService {
  private readonly locks = new Map<string, Promise<void>>()
  private readonly pending = new Set<Promise<void>>()
  private readonly unknown = new Set<string>()
  private readonly lifetime = new AbortController()
  private readonly captures = new Map<string, AbortController>()
  /**
   * @param ctx - Runtime services.
   * @param config - Limits and fixed runtime owner.
   * @param access - Trusted launch authority.
   * @param attach - Installs tools on the exact bound Agent.
   */
  constructor(
    private readonly ctx: Context, private readonly config: Config, private readonly access: ReviewLaunchAccess,
    private readonly attach: (agent: Agent) => void,
  ) {
    const turns = new WeakMap<Agent, { turn: number; triggers: { eventId: string; revision: number }[] }>()
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      if (event.type === 'turn/start') {
        turns.set(agent, { turn: event.data.turn, triggers: [] })
        return
      }
      const turn = turns.get(agent)
      if (turn === undefined) return
      if (event.type === 'user/message' && event.data.source.kind === 'clinical-review-trigger') {
        turn.triggers.push({ eventId: event.data.source.eventId, revision: event.data.source.revision })
        return
      }
      if (event.type !== 'turn/end' || event.data.turn !== turn.turn) return
      turns.delete(agent)
      if (turn.triggers.length === 0) return
      const task = this.finishTurn(agent, turn.triggers, event.data.reason).catch((error: unknown) => {
        ctx.logger.warn(`clinical-review: turn outcome could not be saved (${failureCode(error)})`)
      })
      this.pending.add(task)
      void task.finally(() => { this.pending.delete(task) })
    })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.pending, ...this.locks.values()])
    }, 'clinical-review: admitted work')
  }

  /** Authorize an EMR launch and select its encounter's private Session.
   * @param claim - Validated browser claims.
   * @param signal - Admission cancellation.
   * @returns Bound Session or asynchronous review receipt.
   */
  async launch(claim: LaunchClaim, signal: AbortSignal): Promise<ReviewReceipt> {
    const binding = await this.access.authorize(claim, AbortSignal.any([signal, this.lifetime.signal]))
    if (binding.actorId !== this.config.ownerId) throw new ClinicalReviewError('forbidden', 'The encounter belongs to another account.')
    const digest = createHash('sha256').update(JSON.stringify([binding.actorId, binding.sourceSystem, binding.hospitalCode, binding.inpatId])).digest('hex')
    const id = SessionId(`clinical-${digest.slice(0, 32)}`)
    const agent = await this.serial(`launch:${id}`, async () => {
      signal.throwIfAborted()
      let existing = this.ctx.agents.get(id)
      if (existing === undefined) {
        const stored = await this.ctx.sessionPersistence.stat(id, { signal })
        if (stored === undefined) {
          const created = await this.ctx.sessionController.create({ sessionId: id, cwd: this.config.cwd,
            ...(this.config.agentPreset === undefined ? {} : { agentPreset: this.config.agentPreset }) })
          if (created.sessionId !== id) throw new ClinicalReviewError('session-conflict', 'The encounter Session identity could not be reserved.')
        }
        existing = await this.resolve(id)
      }
      const boundAgent = existing
      await this.serial(id, async () => {
        const current = this.ctx.sessionProjections.stateOf(boundAgent.session, 'clinicalReview')
        if (current === undefined) throw new ClinicalReviewError('projection-unavailable', 'The review state projection is unavailable.')
        if (current === null) {
          await this.commit(boundAgent, {
            schemaVersion: 1, ownerSessionId: id, caseRef: `case-${digest.slice(0, 12)}`, binding,
            revision: 0, status: 'bound', snapshot: null, report: null, readRanges: [], history: [], operations: [],
          })
        } else {
          this.require(boundAgent)
          if (JSON.stringify([current.binding.actorId, current.binding.sourceSystem, current.binding.hospitalCode, current.binding.inpatId])
            !== JSON.stringify([binding.actorId, binding.sourceSystem, binding.hospitalCode, binding.inpatId])) {
            throw new ClinicalReviewError('binding-conflict', 'An boundAgent Session cannot switch to a different encounter.')
          }
          if (JSON.stringify(current.binding) !== JSON.stringify(binding)) {
            if (current.report !== null && current.history.length >= this.config.maxReports) throw new ClinicalReviewError('limit-exceeded', 'This encounter Session reached its report-history limit.')
            await this.commit(boundAgent, { ...current, binding, revision: current.revision + 1, status: 'bound', snapshot: null, report: null, readRanges: [],
              history: current.report === null ? current.history : [...current.history, current.report],
              operations: current.operations.map(operation => operation.status === 'accepted' || operation.status === 'dispatched'
                ? { ...operation, status: 'cancelled', errorCode: 'binding-replaced' } : operation) })
            this.captures.get(boundAgent.id)?.abort()
          }
        }
      })
      this.attach(existing)
      return existing
    })
    if (claim.trigger !== 'open') return this.trigger(agent.id, claim.eventId, claim.trigger, signal)
    return { sessionId: agent.id, revision: this.require(agent).revision, status: 'bound', dischargeBlocked: false }
  }

  /** Admit one review or refresh without waiting for source or model work.
   * @param id - Bound Session.
   * @param eventId - Durable deduplication identity.
   * @param trigger - Review or refresh intent.
   * @param signal - Admission cancellation only.
   * @returns Acknowledged admission; dependent work is asynchronous.
   */
  async trigger(id: SessionId, eventId: string, trigger: ReviewOperation['trigger'], signal: AbortSignal): Promise<ReviewReceipt> {
    const agent = await this.resolve(id)
    return this.serial(id, async () => {
      await this.authorized(agent, signal)
      return this.admit(agent, eventId, trigger, signal)
    })
  }

  private async admit(agent: Agent, eventId: string, trigger: ReviewOperation['trigger'], signal: AbortSignal): Promise<ReviewReceipt> {
    signal.throwIfAborted()
    const state = this.require(agent)
    const previous = state.operations.find(operation => operation.eventId === eventId)
    if (previous !== undefined) {
      if (previous.trigger !== trigger) throw new ClinicalReviewError('request-conflict', 'This request ID was already used with different review parameters.')
      return { sessionId: agent.id, revision: previous.revision, status: 'duplicate', dischargeBlocked: false }
    }
    if (state.operations.length >= this.config.maxOperations) throw new ClinicalReviewError('limit-exceeded', 'This encounter Session reached its configured event limit. An operator must review the retained history and capacity before more events are accepted.')
    if (state.report !== null && state.history.length >= this.config.maxReports) throw new ClinicalReviewError('limit-exceeded', 'This encounter Session reached its report-history limit.')
    const revision = state.revision + 1
    const operation: ReviewOperation = { eventId, trigger, status: 'accepted', revision }
    const next: ReviewState = { ...state, revision, status: 'collecting', report: null, readRanges: [],
      history: state.report === null ? state.history : [...state.history, state.report], operations: [...state.operations, operation] }
    await this.commit(agent, next)
    this.captures.get(agent.id)?.abort()
    const controller = new AbortController()
    this.captures.set(agent.id, controller)
    const task = this.collect(agent, operation, AbortSignal.any([controller.signal, this.lifetime.signal])).catch((error: unknown) => {
      this.ctx.logger.warn(`clinical-review: collection failed (${failureCode(error)})`)
    })
    this.pending.add(task)
    void task.finally(() => { this.pending.delete(task); if (this.captures.get(agent.id) === controller) this.captures.delete(agent.id) })
    return this.receipt(agent, next, 'accepted')
  }

  /** List immutable accepted reports after current binding authorization, without source or model work.
   * @param request - Owned Session and optional expected encounter reference.
   * @param signal - Read cancellation.
   * @returns Newest-first report references and independent current progress.
   */
  async results(request: ResultsRequest, signal: AbortSignal): Promise<ResultsResponse> {
    const agent = await this.resolve(request.sessionId)
    return this.serial(agent.id, async () => {
      const state = await this.authorized(agent, signal, request.encounterRef)
      return { ...this.resultBase(agent, state), results: this.savedSummaries(agent, state).reverse() }
    })
  }

  /** Read one exact accepted revision using its retained evidence, even after a later failed review.
   * @param request - Exact immutable report reference.
   * @param signal - Read cancellation.
   * @returns Original report fields and quotations; missing historical source metadata stays explicit.
   */
  async result(request: ResultRequest, signal: AbortSignal): Promise<ResultResponse> {
    const agent = await this.resolve(request.sessionId)
    return this.serial(agent.id, async () => {
      const state = await this.authorized(agent, signal, request.encounterRef)
      const retained = this.selected(agent, request)
      const history = this.savedSummaries(agent, state)
      const selected = history[request.revision - 1]
      if (selected === undefined) throw new ClinicalReviewError('result-not-found', 'This saved report revision is unavailable.')
      const { report, snapshot } = retained
      return { ...this.resultBase(agent, state), ...selected, summary: report.summary, assessment: report.assessment,
        freshness: this.freshness(agent, state, retained),
        snapshotStatus: snapshot === null ? 'unavailable' : 'retained', coverage: snapshot === null ? [] : [...snapshot.coverage],
        reviewedSourceRefs: [...report.reviewedSourceRefs],
        unreviewedSourceRefs: snapshot === null ? [] : snapshot.sources
          .filter(source => !report.reviewedSourceRefs.includes(source.sourceRef)).map(source => source.sourceRef),
        findings: report.findings.map((finding, index) => ({
          findingId: brandString<ClinicalFindingId>(`clinical-finding:${report.reportId}:${String(index + 1)}`), kind: finding.kind,
          issueCode: finding.kind, legacy: true, fieldKey: null,
          title: finding.title, explanation: finding.explanation, suggestion: finding.suggestion,
          evidenceRefs: finding.citations.map((citation) => {
            const source = snapshot?.sources.find(candidate => candidate.sourceRef === citation.sourceRef
              && candidate.content.slice(citation.start, citation.end) === citation.quote)
            return { ...citation, sourceStatus: source === undefined ? 'unavailable' as const : 'retained' as const,
              source: source === undefined ? null : { sourceId: source.sourceId, sourceRevision: source.sourceRevision,
                category: source.category, state: source.state,
                occurredAt: source.occurredAt ?? null, availableAt: source.availableAt ?? null } }
          }),
        })),
        calculation: { drg: { status: 'unavailable', reason: 'engine-unavailable' }, dip: { status: 'unavailable', reason: 'engine-unavailable' } },
        history: history.reverse(), latestRevision: history.length,
      }
    })
  }

  /** Admit an explicitly requested rerun; retry identities include the original selected result and binding.
   * @param request - Idempotent request with its exact viewer selection.
   * @param signal - Admission cancellation.
   * @returns Original admitted revision on retries; completed reports arrive separately.
   */
  async rerun(request: RerunRequest, signal: AbortSignal): Promise<RerunResponse> {
    const agent = await this.resolve(request.sessionId)
    return this.serial(agent.id, async () => {
      await this.authorized(agent, signal, request.encounterRef)
      this.selected(agent, request)
      const identity = `result-rerun:${createHash('sha256').update(request.requestId).digest('hex')}:`
      const eventId = `${identity}${createHash('sha256').update(JSON.stringify([request.encounterRef, request.resultId, request.revision])).digest('hex')}`
      const prior = this.require(agent).operations.find(operation => operation.eventId.startsWith(identity))
      if (prior !== undefined && prior.eventId !== eventId) throw new ClinicalReviewError('request-conflict', 'This request ID was already used with different result parameters.')
      const receipt = await this.admit(agent, eventId, 'manual-review', signal)
      if (receipt.status === 'bound') throw new ClinicalReviewError('invalid-receipt', 'The review request was not admitted.')
      return { ...receipt, status: receipt.status, requestId: request.requestId }
    })
  }

  private encounterRef(state: ReviewState): ClinicalEncounterRef {
    const identity = [state.binding.sourceSystem, state.binding.hospitalCode, state.binding.inpatId]
    return brandString<ClinicalEncounterRef>(`clinical-encounter:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`)
  }

  private async authorized(agent: Agent, signal: AbortSignal, expected?: ClinicalEncounterRef): Promise<ReviewState> {
    const state = this.require(agent)
    if (expected !== undefined && expected !== this.encounterRef(state)) throw new ClinicalReviewError('forbidden', 'The result does not belong to this encounter binding.')
    await this.access.reauthorize(state.binding, AbortSignal.any([signal, this.lifetime.signal]))
    signal.throwIfAborted()
    const current = this.require(agent)
    if (current.binding.bindingId !== state.binding.bindingId) throw new ClinicalReviewError('binding-conflict', 'The encounter binding changed. Reopen its saved results.')
    return current
  }

  private retained(agent: Agent): readonly RetainedReviewReport[] {
    const value = this.ctx.sessionProjections.stateOf(agent.session, 'clinicalResults')
    if (value === undefined) throw new ClinicalReviewError('projection-unavailable', 'The saved-result projection is unavailable.')
    return value.reports
  }

  private selected(agent: Agent, request: ResultRequest): RetainedReviewReport {
    const selected = this.retained(agent)[request.revision - 1]
    if (request.resultId !== resultIdForSession(agent.id) || selected === undefined) throw new ClinicalReviewError('result-not-found', 'This saved report revision does not belong to the requested Session.')
    return selected
  }

  private savedSummaries(agent: Agent, state: ReviewState): ResultSummary[] {
    return this.retained(agent).map(({ report, snapshot, generatedAt }, index) => ({ sessionId: agent.id,
      encounterRef: this.encounterRef(state), resultId: resultIdForSession(agent.id), revision: index + 1, reportId: report.reportId,
      generatedAt, findingCount: report.findings.length, evidenceRevision: report.caseRevision,
      capturedAt: snapshot?.capturedAt ?? null, cutoff: snapshot?.cutoff ?? null, legacy: true }))
  }

  private resultBase(agent: Agent, state: ReviewState): Omit<ResultsResponse, 'results'> {
    const operation = state.operations.find(item => item.revision === state.revision)
    return { schemaVersion: 1, resultType: 'pre-discharge-review', sessionId: agent.id, encounterRef: this.encounterRef(state),
      encounterLabel: state.binding.inpatCode ?? state.binding.inpatId,
      progress: { revision: state.revision, status: state.status, errorCode: operation?.errorCode ?? null },
      freshness: this.freshness(agent, state, this.retained(agent).at(-1)), dischargeBlocked: false }
  }

  private freshness(agent: Agent, state: ReviewState, retained: RetainedReviewReport | undefined): ResultsResponse['freshness'] {
    const latest = this.ctx.sessionProjections.stateOf(agent.session, 'clinicalResults')?.latestCapture
    if (retained === undefined || retained.snapshot === null || latest === undefined || latest === null
      || latest.revision <= retained.report.revision || latest.snapshot.bindingId !== state.binding.bindingId
      || latest.snapshot.bindingId !== retained.snapshot.bindingId
      || latest.snapshot.providerRevision !== retained.snapshot.providerRevision) {
      return { status: 'unknown', lastCheckedAt: null, scope: 'none' }
    }
    const identity = (snapshot: EncounterSnapshot): string => JSON.stringify({
      sources: [...snapshot.sources].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef))
        .map(({ content: _content, ...source }) => source),
      coverage: [...snapshot.coverage].sort((a, b) => a.category.localeCompare(b.category)),
    })
    return { status: identity(latest.snapshot) === identity(retained.snapshot) ? 'unchanged' : 'changed',
      lastCheckedAt: latest.snapshot.capturedAt, scope: 'accepted-snapshot' }
  }

  /** Read accepted inventory after current broker authorization and freshness checks.
   * @param agent - Exact bound Agent.
   * @param signal - Tool cancellation.
   * @param offset - Source index; zero starts the inventory.
   * @param revision - Required revision for later pages.
   * @returns Bounded model-readable JSON with an explicit next offset.
   */
  load(agent: Agent, signal: AbortSignal, offset = 0, revision?: number): Promise<string> {
    return this.serial(agent.id, async () => {
      const state = await this.fresh(agent, signal)
      if (!Number.isInteger(offset) || offset < 0 || offset > state.snapshot.sources.length) throw new ClinicalReviewError('invalid-range', 'Use a valid inventory source offset.')
      if (offset > 0 && revision === undefined) throw new ClinicalReviewError('missing-revision', 'Later inventory pages require the original review revision.')
      if (revision !== undefined) this.assertRevision(state, revision)
      const end = Math.min(state.snapshot.sources.length, offset + this.config.maxInventoryItems)
      return this.output({ caseRef: state.caseRef, revision: state.revision, caseRevision: state.snapshot.caseRevision,
        capturedAt: state.snapshot.capturedAt, cutoff: state.snapshot.cutoff, providerRevision: state.snapshot.providerRevision,
        sources: state.snapshot.sources.slice(offset, end).map(({ content, ...source }) => ({ ...source, length: content.length })),
        totalSources: state.snapshot.sources.length, nextOffset: end < state.snapshot.sources.length ? end : null,
        coverage: state.snapshot.coverage,
        calculation: { drg: 'unavailable', dip: 'unavailable' }, dischargeBlocked: false,
        instructions: 'Read original evidence with review_read_evidence. Use exact UTF-16 offsets and quotations. Orders alone do not prove execution; unsupported or unread coverage is not clinical absence. Submit only cited proposals for human review; do not compute or invent DRG/DIP groups.' })
    })
  }

  /** Read one bounded original passage from the pinned snapshot.
   * @param agent - Bound Agent.
   * @param revision - Expected review revision.
   * @param sourceRef - Snapshot source reference.
   * @param start - UTF-16 offset.
   * @param length - Requested UTF-16 length.
   * @param signal - Cancellation.
   * @returns Bounded original passage and exact citation coordinates.
   */
  read(agent: Agent, revision: number, sourceRef: string, start: number, length: number, signal: AbortSignal): Promise<string> {
    return this.serial(agent.id, async () => {
      const state = await this.fresh(agent, signal)
      this.assertRevision(state, revision)
      const source = state.snapshot.sources.find(candidate => candidate.sourceRef === sourceRef)
      if (source === undefined) throw new ClinicalReviewError('invalid-source', 'The source is not in this Session snapshot.')
      if (!Number.isInteger(start) || start < 0 || start > source.content.length
        || !Number.isInteger(length) || length < 1 || length > this.config.maxSourceChars) {
        throw new ClinicalReviewError('invalid-range', `Use a valid source offset and a length from 1 to ${String(this.config.maxSourceChars)}.`)
      }
      const end = Math.min(source.content.length, start + length)
      const value = this.output({ revision, caseRevision: state.snapshot.caseRevision, sourceRef, sourceRevision: source.sourceRevision,
        category: source.category, state: source.state, start, end, totalLength: source.content.length,
        content: source.content.slice(start, end), nextOffset: end < source.content.length ? end : null })
      const readRanges = mergeRange(state.readRanges, { sourceRef, start, end })
      await this.commit(agent, { ...state, readRanges })
      return value
    })
  }

  /** Persist a cited model proposal after source/revision checks.
   * @param agent - Bound Agent.
   * @param proposal - Validated model input.
   * @param signal - Cancellation.
   * @returns Report and coverage without discharge or payment decisions.
   */
  submit(agent: Agent, proposal: SubmitFindings, signal: AbortSignal): Promise<string> {
    const parsed = proposalSchema.safeParse(proposal)
    if (!parsed.success) return Promise.reject(new ClinicalReviewError('invalid-proposal', 'Use a nonempty summary of at most 8000 characters and valid finding fields.'))
    return this.serial(agent.id, async () => {
      const state = await this.fresh(agent, signal)
      this.assertRevision(state, proposal.revision)
      if (state.snapshot.caseRevision !== proposal.caseRevision) throw new ClinicalReviewError('stale-revision', 'The evidence snapshot changed. Refresh the inventory before submitting findings.')
      if (proposal.findings.length > this.config.maxFindings) throw new ClinicalReviewError('limit-exceeded', 'The report exceeds the configured finding limit.')
      if (state.report !== null) throw new ClinicalReviewError('report-exists', 'This revision already has a report. Start a fresh review to revise it.')
      const refs = new Set(proposal.reviewedSourceRefs)
      if (refs.size !== proposal.reviewedSourceRefs.length) throw new ClinicalReviewError('invalid-source', 'Reviewed source references must be unique.')
      for (const [index, ref] of proposal.reviewedSourceRefs.entries()) {
        const source = state.snapshot.sources.find(candidate => candidate.sourceRef === ref)
        if (source === undefined) throw new ClinicalReviewError('unread-source', `reviewedSourceRefs[${String(index)}] is not in this Session snapshot. Remove it from reviewedSourceRefs. Partial citations still require exact text already read from the snapshot.`)
        if (!covers(state, ref, 0, source.content.length)) throw new ClinicalReviewError('unread-source', `Source ${source.sourceRef} at reviewedSourceRefs[${String(index)}] has not been fully read. Read its complete original content or remove it from reviewedSourceRefs. Partial citations still require exact text already read from the snapshot.`)
      }
      for (const [findingIndex, finding] of proposal.findings.entries()) {
        if (finding.kind !== 'missing-information' && finding.citations.length === 0) throw new ClinicalReviewError('missing-citation', 'Clinical inconsistencies and verification findings require original evidence citations.')
        for (const [citationIndex, citation] of finding.citations.entries()) {
          const source = state.snapshot.sources.find(candidate => candidate.sourceRef === citation.sourceRef)
          if (source === undefined || citation.end > source.content.length
            || source.content.slice(citation.start, citation.end) !== citation.quote
            || !covers(state, citation.sourceRef, citation.start, citation.end)) {
            const location = `findings[${String(findingIndex)}].citations[${String(citationIndex)}]${source === undefined ? '' : ` for source ${source.sourceRef}`}`
            throw new ClinicalReviewError('invalid-citation', `Citation ${location} must reference a source in this Session snapshot and quote exact text within offsets already read. Correct the source, offsets, and quotation, or read the required passage first.`)
          }
        }
      }
      const reportId = brandString<ReviewReportId>(createHash('sha256').update(JSON.stringify([state.binding.bindingId, state.revision, proposal])).digest('hex'))
      const report: ReviewReport = { reportId, revision: state.revision, caseRevision: state.snapshot.caseRevision,
        summary: proposal.summary, findings: proposal.findings, reviewedSourceRefs: [...refs],
        assessment: 'pending-human-review', calculation: { drg: 'unavailable', dip: 'unavailable' } }
      const next: ReviewState = { ...state, status: 'reviewed', report }
      const output = this.output(this.reportView(next))
      await this.commit(agent, next)
      return output
    })
  }

  /** Read the current report after authorization and freshness verification.
   * @param agent - Bound Agent.
   * @param signal - Cancellation.
   * @returns Readable report, pending state, and coverage.
   */
  report(agent: Agent, signal: AbortSignal): Promise<string> {
    return this.serial(agent.id, async () => this.output(this.reportView(await this.fresh(agent, signal))))
  }

  /** Read private status without issuing patient queries or waking a model.
   * @param id - Bound Session.
   * @returns Current status; unknown durability is explicit.
   */
  async status(id: SessionId): Promise<object> {
    const agent = await this.resolve(id)
    const state = this.require(agent, true)
    return { sessionId: id, caseRef: state.caseRef, revision: state.revision, status: state.status, reportAvailable: state.report !== null,
      calculation: { drg: 'unavailable', dip: 'unavailable' }, dischargeBlocked: false, durability: this.unknown.has(id) ? 'unknown' : 'confirmed',
      operations: state.operations.map(operation => ({ ...operation })) }
  }

  /** Mark resumed unfinished work as interrupted without replaying a model wake.
   * @param agent - Resumed Agent whose durable Session is already loaded.
   * @returns Completion of the durable interruption update, if any.
   */
  recover(agent: Agent): Promise<void> {
    return this.serial(agent.id, async () => {
      const state = this.ctx.sessionProjections.stateOf(agent.session, 'clinicalReview')
      if (state === undefined || state === null || state.ownerSessionId !== agent.id
        || state.binding.actorId !== this.config.ownerId) return
      const incomplete = state.operations.filter(operation => (operation.status === 'accepted' || operation.status === 'dispatched')
        && state.report?.revision !== operation.revision && !state.history.some(report => report.revision === operation.revision))
      if (incomplete.length === 0) return
      const ids = new Set(incomplete.map(operation => operation.eventId))
      await this.commit(agent, { ...state, ...(incomplete.some(operation => operation.revision === state.revision) ? { status: 'failed' as const } : {}),
        operations: state.operations.map(operation => ids.has(operation.eventId) ? { ...operation, status: 'failed', errorCode: 'interrupted' } : operation) })
    })
  }

  /** Return only locally accepted binding state, rejecting inherited authority.
   * @param agent - Exact live Agent.
   * @param allowUnknown - Status-only exception to the durability stop.
   * @returns Its owned state.
   */
  require(agent: Agent, allowUnknown = false): ReviewState {
    this.lifetime.signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new ClinicalReviewError('inactive-session', 'Resume the encounter Session before reviewing it.')
    const state = this.ctx.sessionProjections.stateOf(agent.session, 'clinicalReview')
    if (state === undefined) throw new ClinicalReviewError('projection-unavailable', 'The review state projection is unavailable.')
    if (state === null) throw new ClinicalReviewError('unbound-session', 'Open an authorized EMR encounter before using clinical review tools.')
    if (state.ownerSessionId !== agent.id) throw new ClinicalReviewError('inherited-binding', 'Forked history does not authorize patient reads. Open a fresh authorized encounter Session.')
    if (state.binding.actorId !== this.config.ownerId) throw new ClinicalReviewError('forbidden', 'The encounter belongs to another account.')
    if (!allowUnknown && this.unknown.has(agent.id)) throw new ClinicalReviewError('durability-unknown', 'Review persistence is uncertain. Reconcile this Session before starting dependent work.')
    return state
  }

  private async collect(agent: Agent, operation: ReviewOperation, signal: AbortSignal): Promise<void> {
    try {
      const binding = this.require(agent).binding
      const snapshot = await this.capture(binding, signal)
      signal.throwIfAborted()
      await this.serial(agent.id, async () => {
        const state = this.require(agent)
        if (state.revision !== operation.revision) return
        signal.throwIfAborted()
        const next: ReviewState = { ...state, snapshot, status: operation.trigger === 'refresh' ? 'stale' : 'reviewing',
          operations: state.operations.map(item => item.eventId === operation.eventId
            ? { ...item, status: operation.trigger === 'refresh' ? 'refreshed' : 'dispatched' } : item) }
        await this.commit(agent, next)
        if (operation.trigger === 'refresh') return
        const message = createUserMessage({ source: { kind: 'clinical-review-trigger', eventId: operation.eventId, revision: next.revision },
          content: [{ type: 'text', text: `Review the authorized encounter ${next.caseRef} before discharge at revision ${String(next.revision)}. First call review_load_case, read relevant original evidence with review_read_evidence, then submit cited findings with review_submit_findings. Distinguish missing/unread sources and order intent from execution. This is advisory and never blocks discharge. Findings require human review. DRG and DIP calculation are unavailable; do not invent groups, scores, or payment conclusions. Write the report summary, finding titles, explanations, suggestions, and final reply in ${this.config.reviewLanguage}.` }] })
        agent.followup(message)
        await this.flush(agent)
      })
    } catch (error) {
      await this.serial(agent.id, async () => {
        if (this.unknown.has(agent.id)) return
        const state = this.require(agent)
        const cancelled = signal.aborted
        await this.commit(agent, { ...state, ...(state.revision === operation.revision ? { status: cancelled ? 'cancelled' as const : 'failed' as const } : {}),
          operations: state.operations.map(item => item.eventId === operation.eventId
            ? { ...item, status: cancelled ? 'cancelled' : 'failed', errorCode: failureCode(error) } : item) })
      })
    }
  }

  private finishTurn(agent: Agent, triggers: readonly { eventId: string; revision: number }[], reason: TurnEndReason): Promise<void> {
    return this.serial(agent.id, async () => {
      if (this.unknown.has(agent.id) || this.ctx.agents.get(agent.id) !== agent) return
      const state = this.ctx.sessionProjections.stateOf(agent.session, 'clinicalReview')
      if (state === undefined || state === null || state.ownerSessionId !== agent.id || state.binding.actorId !== this.config.ownerId
        || state.status !== 'reviewing' || state.report !== null) return
      const operation = state.operations.find(item => item.revision === state.revision && item.status === 'dispatched'
        && triggers.some(trigger => trigger.revision === item.revision && trigger.eventId === item.eventId))
      if (operation === undefined) return
      const cancelled = reason.kind === 'aborted'
      const errorCode = reason.kind === 'completed' ? 'report-not-submitted' : `model-turn-${reason.kind}`
      await this.commit(agent, { ...state, status: cancelled ? 'cancelled' : 'failed',
        operations: state.operations.map(item => item.eventId === operation.eventId
          ? { ...item, status: cancelled ? 'cancelled' : 'failed', errorCode } : item) })
    })
  }

  private async fresh(agent: Agent, signal: AbortSignal): Promise<ReviewState & { snapshot: EncounterSnapshot }> {
    const state = this.require(agent)
    if (state.snapshot === null || state.status === 'collecting' || state.status === 'failed' || state.status === 'cancelled') {
      throw new ClinicalReviewError('snapshot-unavailable', 'An accepted evidence snapshot is not ready. Request or retry the asynchronous review.')
    }
    const current = await this.capture(state.binding, signal)
    signal.throwIfAborted()
    this.assertRevision(this.require(agent), state.revision)
    if (current.caseRevision !== state.snapshot.caseRevision || current.providerRevision !== state.snapshot.providerRevision) {
      await this.commit(agent, { ...state, status: 'stale' })
      throw new ClinicalReviewError('stale-evidence', 'Source evidence changed. Start a fresh review before reading or submitting against it.')
    }
    return { ...state, snapshot: state.snapshot }
  }

  private capture(binding: EncounterBinding, signal: AbortSignal): Promise<EncounterSnapshot> {
    return this.ctx.encounterReader.capture({ id: binding.actorId, issuer: binding.actorIssuer, subject: binding.actorSubject }, binding,
      AbortSignal.any([signal, this.lifetime.signal]))
  }

  private reportView(state: ReviewState): object {
    return { caseRef: state.caseRef, revision: state.revision, status: state.status,
      capturedAt: state.snapshot?.capturedAt ?? null, cutoff: state.snapshot?.cutoff ?? null,
      coverage: state.snapshot?.coverage ?? [], report: state.report,
      unreviewedSourceRefs: state.snapshot?.sources.filter(source => !state.report?.reviewedSourceRefs.includes(source.sourceRef))
        .map(source => source.sourceRef) ?? [],
      calculation: { drg: 'unavailable', dip: 'unavailable' }, dischargeBlocked: false }
  }

  private output(value: object): string {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(JSON.stringify([{ type: 'text', text }])) > this.config.maxToolBytes) throw new ClinicalReviewError('limit-exceeded', 'The complete tool result exceeds its configured limit. Request a shorter passage or report.')
    return text
  }

  private assertRevision(state: ReviewState, revision: number): void {
    if (state.revision !== revision) throw new ClinicalReviewError('stale-revision', 'The review revision changed. Read the current inventory and restart the finding proposal.')
  }

  private receipt(agent: Agent, state: ReviewState, status: ReviewReceipt['status']): ReviewReceipt {
    return { sessionId: agent.id, revision: state.revision, status, dischargeBlocked: false }
  }

  private async resolve(id: SessionId): Promise<Agent> {
    const resolved = await this.ctx.sessionController.resolveAgent(id)
    if ('error' in resolved) throw new ClinicalReviewError('session-unavailable', 'The encounter Session is unavailable.')
    return resolved.agent
  }

  private async commit(agent: Agent, state: ReviewState): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(state)) > this.config.maxStateBytes) throw new ClinicalReviewError('limit-exceeded', 'The complete retained review state exceeds its configured limit.')
    appendPluginRecord(agent.session, 'plugin:clinical-review/state', state)
    await this.flush(agent)
  }

  private async flush(agent: Agent): Promise<void> {
    try {
      if (!await this.ctx.sessions.flush(agent.session)) throw new ClinicalReviewError('persistence-unavailable', 'No durable Session writer accepted the review state.')
    } catch (error) {
      this.unknown.add(agent.id)
      throw new ClinicalReviewError('durability-unknown', `Review persistence is uncertain (${failureCode(error)}). No dependent review action is accepted.`)
    }
  }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.locks.get(key) ?? Promise.resolve()).then(operation)
    const settled = task.then(() => {}, () => {})
    this.locks.set(key, settled)
    void settled.then(() => { if (this.locks.get(key) === settled) this.locks.delete(key) })
    return task
  }
}

function failureCode(error: unknown): string {
  if (error instanceof ClinicalReviewError || error instanceof EncounterReadError) return error.code
  return error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'review-unavailable'
}

function covers(state: ReviewState, sourceRef: string, start: number, end: number): boolean {
  return state.readRanges.some(range => range.sourceRef === sourceRef && range.start <= start && range.end >= end)
}

function mergeRange(ranges: ReviewState['readRanges'], added: ReviewState['readRanges'][number]): ReviewState['readRanges'] {
  const other = ranges.filter(range => range.sourceRef !== added.sourceRef)
  const same = [...ranges.filter(range => range.sourceRef === added.sourceRef), added].sort((a, b) => a.start - b.start)
  const result: { sourceRef: string; start: number; end: number }[] = []
  for (const range of same) {
    const last = result.at(-1)
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else result.push({ ...range })
  }
  return [...other, ...result]
}
