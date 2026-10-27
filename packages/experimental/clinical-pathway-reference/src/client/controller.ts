/** Instance-owned reference reads and creation; late results cannot cross Session boundaries. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { viewSchema } from '../protocol.ts'
import type { ReferenceConfig, ReferenceView } from '../types.ts'

/** Observable network state; clinical edits are unavailable in this preview. */
export interface ReferencePreviewState {
  open: boolean
  sessionId: SessionId | null
  busy: boolean
  value: ReferenceView | null
  creationUnconfirmed: boolean
  issue: 'readFailed' | 'createUnconfirmed' | 'denied' | null
}

/** One overlay's bounded request owner; no reference data is shared between Sessions. */
export class ReferenceController {
  /** The slot renderer binds the subscription hook for this observable. */
  readonly view = createSnapshotStore<ReferencePreviewState>({
    open: false, sessionId: null, busy: false, value: null, issue: null, creationUnconfirmed: false,
  })
  private readonly lifetime = new AbortController()
  private request: AbortController | null = null
  private observedRevision = 0
  private attemptedRevision = 0
  private createAttempt: { sessionId: SessionId; signature: string; requestId: string } | null = null

  /**
   * Own preview requests for one overlay lifetime.
   * @param config - Public authorized scope.
   * @param send - Same-origin authenticated fetch transport.
   */
  constructor(private readonly config: ReferenceConfig, private readonly send: typeof fetch) {}

  /**
   * Open the preview and load the selected Session.
   * @param sessionId - Private Session owning the reference.
   * @returns Settlement of the initial read.
   */
  show(sessionId: SessionId): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    const same = this.view.getSnapshot().sessionId === sessionId
    this.request?.abort()
    if (!same) { this.createAttempt = null; this.observedRevision = 0; this.attemptedRevision = 0 }
    this.view.update((value) => {
      value.open = true; value.sessionId = sessionId; value.issue = null
      if (!same) { value.value = null; value.creationUnconfirmed = false }
    })
    return this.refresh()
  }

  /** Close the preview and invalidate all in-flight callbacks without altering the saved reference. */
  close(): void {
    this.request?.abort()
    this.request = null
    this.view.update((value) => {
      value.open = false; value.busy = false; value.value = null; value.sessionId = null
      value.issue = null; value.creationUnconfirmed = false
    })
    this.createAttempt = null
    this.observedRevision = 0; this.attemptedRevision = 0
  }

  /**
   * Close the preview when its owning Session header leaves.
   * @param sessionId - Header owner being removed.
   */
  leave(sessionId: SessionId): void { if (this.view.getSnapshot().sessionId === sessionId) this.close() }

  /**
   * Observe saved revision changes for the currently open Session.
   * @param sessionId - Session whose metadata changed.
   * @param revision - Latest committed reference revision advertised by the Session projection.
   */
  observeRevision(sessionId: SessionId, revision: number): void {
    const state = this.view.getSnapshot()
    if (!state.open || state.sessionId !== sessionId || this.lifetime.signal.aborted) return
    this.observedRevision = Math.max(this.observedRevision, revision)
    this.readObservedRevision()
  }

  private readObservedRevision(): void {
    const state = this.view.getSnapshot()
    const loaded = state.value?.state?.revisions.at(-1)?.revision ?? 0
    if (this.request !== null || !state.open || this.lifetime.signal.aborted
      || this.observedRevision <= loaded || this.observedRevision <= this.attemptedRevision) return
    void this.refresh()
  }

  /**
   * Refresh the last confirmed view without discarding it on failure.
   * @returns Completion of a read; a failed refresh retains the last known data.
   */
  refresh(): Promise<void> { return this.perform('read', {}) }

  /**
   * Create one reference task with an idempotent request identity.
   * @param mode - New reference or exact logged definition.
   * @param title - Task title, not a clinical field.
   * @param sourceEventSeq - Required for revisions.
   * @returns Settlement; uncertain creates require a read before retry.
   */
  create(mode: 'new' | 'revision', title: string, sourceEventSeq?: number): Promise<void> {
    const state = this.view.getSnapshot()
    if (state.busy || state.creationUnconfirmed || state.sessionId === null || state.value?.state !== null) return Promise.resolve()
    const signature = JSON.stringify({ mode, title, sourceEventSeq })
    if (this.createAttempt?.sessionId !== state.sessionId || this.createAttempt.signature !== signature) {
      this.createAttempt = { sessionId: state.sessionId, signature, requestId: randomUUID() }
    }
    return this.perform('create', { mode, title, scope: this.config.scope, requestId: this.createAttempt.requestId,
      ...(sourceEventSeq === undefined ? {} : { sourceEventSeq }) })
  }

  private async perform(operation: 'read' | 'create', body: object): Promise<void> {
    const initial = this.view.getSnapshot()
    if (!initial.open || initial.sessionId === null || this.lifetime.signal.aborted) return
    this.request?.abort()
    const request = new AbortController()
    this.request = request
    if (operation === 'read') this.attemptedRevision = Math.max(this.attemptedRevision, this.observedRevision)
    const sessionId = initial.sessionId
    const current = (): boolean => this.request === request && !request.signal.aborted && !this.lifetime.signal.aborted
      && this.view.getSnapshot().open && this.view.getSnapshot().sessionId === sessionId
    this.view.update((value) => { value.busy = true; value.issue = null })
    try {
      const send = this.send
      const response = await send(`api/pathway-reference/${operation}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...body }),
        signal: AbortSignal.any([request.signal, this.lifetime.signal]) })
      if (!current()) return
      if (response.status === 401 || response.status === 403) {
        this.view.update((value) => { value.value = null; value.issue = 'denied' })
        return
      }
      if (!response.ok) throw new Error('Reference request did not complete')
      const result = viewSchema.parse(await response.json())
      if (!current()) return
      if (result.state !== null && result.state.ownerSessionId !== sessionId) throw new Error('Reference Session mismatch')
      this.view.update((value) => { value.value = result; value.issue = null; value.creationUnconfirmed = false })
    } catch (_requestFailed: unknown) {
      if (current()) this.view.update((value) => {
        value.issue = operation === 'create' ? 'createUnconfirmed' : 'readFailed'
        if (operation === 'create') value.creationUnconfirmed = true
      })
    } finally {
      if (current()) this.view.update((value) => { value.busy = false })
      if (this.request === request) {
        this.request = null
        this.readObservedRevision()
      }
    }
  }

  /** Invalidate pending reads and creation responses when the plugin unloads. */
  dispose(): void { this.lifetime.abort(); this.close() }
}
