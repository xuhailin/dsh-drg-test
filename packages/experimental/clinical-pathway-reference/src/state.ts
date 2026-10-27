/** Single Session-owned revision log; confirmed state is returned only after a durability checkpoint. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendPluginRecord, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { z } from 'zod'
import type { DefinitionDocument } from './emr/definition.generated.d.ts'
import { readDefinition } from './emr/definition-reader.ts'
import { applyChange, canonical, changedIds, objects, validateLocks } from './change.ts'
import { ReferenceError } from './error.ts'
import { commitRequestSchema, createRequestSchema, stateSchema, undoRequestSchema } from './protocol.ts'
import type { ReferenceConfig, ReferenceMetadata, ReferenceState, ReferenceView } from './types.ts'

type Create = z.infer<typeof createRequestSchema>
type Commit = z.infer<typeof commitRequestSchema>
type Undo = z.infer<typeof undoRequestSchema>
const emptyMetadata: ReferenceMetadata = { coverage: [], questions: [], evidence: [] }
function sameScope(a: ReferenceConfig['scope'], b: ReferenceConfig['scope']): boolean {
  return a.sourceSystem === b.sourceSystem && a.hospitalCode === b.hospitalCode
    && canonical([...new Set(a.departmentCodes)].sort()) === canonical([...new Set(b.departmentCodes)].sort())
    && Date.parse(a.admissionFrom) === Date.parse(b.admissionFrom) && Date.parse(a.admissionTo) === Date.parse(b.admissionTo)
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function latest(state: ReferenceState) {
  const revision = state.revisions.at(-1)
  if (revision === undefined) throw new ReferenceError('invalid-request', 'A reference task must contain a saved revision.')
  return revision
}
function operationDigest(action: string, request: { sessionId: SessionId }): string {
  const { sessionId: _owner, ...payload } = request
  return digest({ action, ...payload })
}
function blank(requestId: string): DefinitionDocument {
  return readDefinition({ format: 'emr-clinical-pathway-definition', schemaVersion: 1, clinicalPathway: {
    localId: `pathway:${digest(requestId).slice(0, 32)}`, name: null, feesRange: null, inpatDayRange: null,
    deptInfos: [], diagnoseGroup: [], inclusionAssessment: [], treatments: [],
  } })
}

/** Persistence and serialization owner for one optional runtime, with no hospital write capability. */
export class ReferenceService {
  private readonly pending = new Map<SessionId, Promise<unknown>>()
  private readonly uncertain = new Set<SessionId>()
  private readonly confirmed = new WeakSet<Session>()
  private closing = false
  /**
   * Own serialized reference operations for one optional runtime.
   * @param ctx - Session/projection/controller services.
   * @param config - Explicit scope and retained-state bounds.
   */
  constructor(private readonly ctx: Context, readonly config: ReferenceConfig) {}
  /** Stop admission and await accepted checkpoints before dependencies are released. */
  async dispose(): Promise<void> { this.closing = true; await Promise.allSettled([...this.pending.values()]) }
  /**
   * Check the committed preset before admitting reference operations.
   * @param agent - Active Session owner.
   * @returns Whether this is the committed pathway preset.
   */
  ownsPreset(agent: Agent): boolean { return this.ctx.sessionProjections.stateOf(agent.session, 'agentPreset') === 'clinical-pathway-analysis' }
  private async serial<T>(id: SessionId, operation: (agent: Agent, state: ReferenceState | null) => Promise<T>): Promise<T> {
    if (this.closing) throw new ReferenceError('unavailable', 'The reference owner is stopping. Reopen after reconnecting.')
    const previous = this.pending.get(id) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(async () => {
      if (this.uncertain.has(id)) throw new ReferenceError('durability-unknown', 'The last save outcome is unknown. Reconnect after restarting the runtime before editing this reference.')
      const resolved = await this.ctx.sessionController.resolveAgent(id)
      if ('error' in resolved) throw new ReferenceError('not-found', 'This private Session is unavailable.')
      const agent = resolved.agent
      if (!this.ownsPreset(agent)) throw new ReferenceError('forbidden', 'Reference drafts require the clinical pathway analysis preset.')
      const saved = this.ctx.sessionProjections.stateOf(agent.session, 'clinicalPathwayReference') ?? null
      if (saved !== null && saved.ownerSessionId !== id) throw new ReferenceError('forbidden', 'A fork cannot read or modify its parent reference task. Use the original Session.')
      if (saved !== null && !this.confirmed.has(agent.session)) await this.checkpoint(agent)
      return operation(agent, saved === null ? null : stateSchema.parse(saved))
    })
    this.pending.set(id, run)
    try { return await run } finally { if (this.pending.get(id) === run) this.pending.delete(id) }
  }
  private sources(agent: Agent) {
    return (this.ctx.sessionProjections.stateOf(agent.session, 'clinicalPathwayReferenceSources')?.sources ?? [])
      .filter(source => sameScope(source.scope, this.config.scope))
  }
  private view(agent: Agent, state: ReferenceState | null): ReferenceView {
    return { state, sources: this.sources(agent).map(source => ({ eventSeq: source.eventSeq, definitionId: source.definitionId,
      label: source.definition.clinicalPathway.name ?? source.definitionId, readAt: source.readAt, coverage: source.metadata.coverage })) }
  }
  private matchScope(scope: ReferenceConfig['scope']): void {
    if (!sameScope(scope, this.config.scope)) throw new ReferenceError('forbidden', 'The task scope must match this runtime’s authorized analysis scope.')
  }
  private duplicate(state: ReferenceState, requestId: string, hash: string): boolean {
    const existing = state.revisions.find(revision => revision.requestId === requestId)
    if (existing === undefined) return false
    if (existing.requestDigest !== hash) throw new ReferenceError('conflict', 'This operation identity was already used with different content.')
    return true
  }
  private async save(agent: Agent, state: ReferenceState): Promise<void> {
    const parsed = stateSchema.parse(state)
    if (parsed.revisions.length > this.config.maxRevisions || Buffer.byteLength(JSON.stringify(parsed)) > this.config.maxStateBytes) throw new ReferenceError('limit-exceeded', 'The reference history is full. This change was not saved.')
    appendPluginRecord(agent.session, 'plugin:clinical-pathway-reference/state', parsed)
    await this.checkpoint(agent)
  }
  private async checkpoint(agent: Agent): Promise<void> {
    try {
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('No Session durability owner is installed.')
      this.confirmed.add(agent.session)
    } catch (error) {
      this.uncertain.add(agent.id)
      throw new ReferenceError('durability-unknown', `The save outcome could not be confirmed (${error instanceof Error ? error.name : 'persistence failure'}). Keep the last confirmed preview and restart before continuing.`)
    }
  }
  /**
   * Read saved revisions and source choices in the configured scope.
   * @param id - Exact private Session.
   * @returns Latest confirmed reference and exact logged source choices.
   */
  read(id: SessionId): Promise<ReferenceView> { return this.serial(id, (agent, state) => Promise.resolve(this.view(agent, state))) }
  /**
   * Create one reference task in its owning Session.
   * @param request - Validated task and source selection.
   * @returns Saved initial revision.
   */
  create(request: Create): Promise<ReferenceView> {
    return this.serial(request.sessionId, async (agent, state) => {
      this.matchScope(request.scope)
      const hash = operationDigest('create', request)
      if (state !== null) {
        if (this.duplicate(state, request.requestId, hash)) return this.view(agent, state)
        throw new ReferenceError('conflict', 'This Session already owns a reference task. Continue its saved revisions.')
      }
      if (request.mode === 'new' && request.sourceEventSeq !== undefined) throw new ReferenceError('invalid-request', 'A new pathway cannot select a revision source.')
      const source = request.mode === 'revision' ? this.sources(agent).find(entry => entry.eventSeq === request.sourceEventSeq) : undefined
      if (request.mode === 'revision' && source === undefined) throw new ReferenceError('invalid-request', 'Select one exact logged pathway definition from this Session and scope.')
      const definition = source?.definition ?? blank(request.requestId)
      const metadata = structuredClone(source?.metadata ?? emptyMetadata)
      if (source !== undefined) for (const localId of objects(definition).keys()) metadata.evidence.push({ localId, sourceRef: `session-event:${source.eventSeq}`, observedAt: source.readAt, kind: 'source' })
      const created: ReferenceState = { schemaVersion: 1, ownerSessionId: agent.id,
        mode: request.mode, title: request.title, scope: request.scope,
        baseline: source?.definition ?? null,
        source: source === undefined ? null : { eventSeq: source.eventSeq, definitionId: source.definitionId,
          sourceSystem: source.sourceSystem, readAt: source.readAt },
        revisions: [{ revision: 1, requestId: request.requestId, requestDigest: hash,
          createdAt: new Date().toISOString(),
          definition, metadata, locks: [], changedLocalIds: [], undoes: null }],
      }
      await this.save(agent, created)
      return this.view(agent, created)
    })
  }
  /**
   * Save a complete proposal against its observed base revision.
   * @param request - Atomic complete candidate and base revision.
   * @param model - Deny model changes to user-owned locks.
   * @returns Confirmed merged revision.
   */
  commit(request: Commit, model = false): Promise<ReferenceView> {
    return this.serial(request.sessionId, async (agent, state) => {
      if (state === null) throw new ReferenceError('not-found', 'Create the reference task first.')
      const hash = operationDigest('commit', request)
      if (this.duplicate(state, request.requestId, hash)) return this.view(agent, state)
      const current = latest(state), base = state.revisions.find(entry => entry.revision === request.baseRevision)
      if (base === undefined) throw new ReferenceError('conflict', 'The selected base revision is unavailable.')
      if (model && request.locks !== undefined) throw new ReferenceError('forbidden', 'Only the user can change reference locks.')
      if (request.locks !== undefined && request.baseRevision !== current.revision) {
        throw new ReferenceError('conflict', 'Refresh before changing locks.')
      }
      const definition = applyChange(base.definition, request.definition, current.definition, current.locks)
      const metadata = request.metadata === undefined ? current.metadata
        : this.mergeMetadata(base.metadata, request.metadata, current.metadata)
      const locks = validateLocks(definition, request.locks ?? current.locks)
      const next = { ...state, revisions: [...state.revisions, {
        revision: current.revision + 1, requestId: request.requestId, requestDigest: hash,
        createdAt: new Date().toISOString(), definition, metadata, locks,
        changedLocalIds: changedIds(current.definition, definition), undoes: null,
      }] }
      await this.save(agent, next)
      return this.view(agent, next)
    })
  }
  private mergeMetadata(base: ReferenceMetadata, candidate: ReferenceMetadata, current: ReferenceMetadata): ReferenceMetadata {
    if (canonical(base) === canonical(candidate)) return current
    if (canonical(base) !== canonical(current)) throw new ReferenceError('conflict', 'Reference evidence or coverage changed. Refresh before replacing metadata.')
    return candidate
  }
  /**
   * Save a compensating revision while preserving independent later edits.
   * @param request - Selected revision and latest observed revision.
   * @param model - Deny undo operations that would change user-owned locks.
   * @returns A compensating revision preserving independent later edits.
   */
  undo(request: Undo, model = false): Promise<ReferenceView> {
    return this.serial(request.sessionId, async (agent, state) => {
      if (state === null) throw new ReferenceError('not-found', 'Create the reference task first.')
      const hash = operationDigest('undo', request)
      if (this.duplicate(state, request.requestId, hash)) return this.view(agent, state)
      const current = latest(state), target = state.revisions.find(entry => entry.revision === request.revision)
      const before = state.revisions.find(entry => entry.revision === request.revision - 1)
      if (current.revision !== request.baseRevision || target === undefined || before === undefined || state.revisions.some(entry => entry.undoes === target.revision)) throw new ReferenceError('conflict', 'Refresh and select a saved change that has not already been undone.')
      const definition = applyChange(target.definition, before.definition, current.definition, current.locks)
      const metadata = this.mergeMetadata(target.metadata, before.metadata, current.metadata)
      if (canonical(target.locks) !== canonical(before.locks) && canonical(current.locks) !== canonical(target.locks)) throw new ReferenceError('conflict', 'Locks changed after this revision.')
      const locks = validateLocks(definition, canonical(target.locks) === canonical(before.locks) ? current.locks : before.locks)
      if (model && canonical(locks) !== canonical(current.locks)) throw new ReferenceError('forbidden', 'Only the user can change reference locks, including through undo.')
      const next = { ...state, revisions: [...state.revisions, {
        revision: current.revision + 1, requestId: request.requestId, requestDigest: hash,
        createdAt: new Date().toISOString(), definition, metadata, locks,
        changedLocalIds: changedIds(current.definition, definition), undoes: target.revision,
      }] }
      await this.save(agent, next)
      return this.view(agent, next)
    })
  }
}
