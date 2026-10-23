/** Instance-owned saved-result reads, explicit selection, and independent rerun admission. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { resultResponseSchema, resultsResponseSchema, rerunResponseSchema, type ResultResponse, type ResultsResponse, type RerunResponse } from '@deepseek-ai/dsh-experimental-clinical-review/result'
import type { ViewerConfig } from '../types.ts'
import type { ResultRef, ResultSelection } from './protocol.ts'

/** Recoverable read failures are distinct from missing, unsupported, and unauthorized results. */
export type ViewerPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'choose' | 'login' | 'denied' | 'not-found' | 'unsupported' | 'failed'
/** One view owns its selected revision; progress updates never select another report. */
export interface ViewerState {
  phase: ViewerPhase
  selection: ResultSelection | null
  result: ResultResponse | null
  listing: ResultsResponse | null
  rerun: 'idle' | 'pending' | 'accepted' | 'failed' | 'unknown'
}
const empty: ViewerState = { phase: 'idle', selection: null, result: null, listing: null, rerun: 'idle' }

/** Browser request owner; disposal and selection changes invalidate all late responses. */
export class ResultController {
  /** Bare snapshot source bound to React only by the slot renderer. */
  readonly view = createSnapshotStore<ViewerState>(empty)
  private readonly lifetime = new AbortController()
  private read: AbortController | null = null
  private generation = 0
  private scope = 0
  private rerunRequest: AbortController | null = null
  private pendingRerun: Promise<RerunResponse | null> | null = null

  /**
   * @param config - public deployment request bounds.
   * @param send - authenticated same-origin HTTP transport.
   */
  constructor(private readonly config: ViewerConfig, private readonly send: typeof fetch) {}

  /**
   * Open a reference or listing without capturing evidence or starting analysis.
   * @param selection - validated reference; the server independently authorizes it.
   * @returns settlement of the bounded read; failures remain visible in the view.
   */
  async open(selection: ResultSelection): Promise<void> {
    if (this.lifetime.signal.aborted) return
    this.read?.abort()
    const read = new AbortController(), generation = ++this.generation
    this.read = read
    const current = (): boolean => generation === this.generation && !this.lifetime.signal.aborted
    const previous = this.view.getSnapshot()
    const sameEncounter = previous.selection?.sessionId === selection.sessionId
      && previous.selection.encounterRef === selection.encounterRef
    if (!sameEncounter) { this.scope++; this.rerunRequest?.abort(); this.rerunRequest = null; this.pendingRerun = null }
    this.view.set({ phase: 'loading', selection, result: sameEncounter ? previous.result : null,
      listing: sameEncounter ? previous.listing : null, rerun: sameEncounter ? previous.rerun : 'idle' })
    try {
      const exact = selection.resultId !== undefined && selection.revision !== undefined
      const value = await this.request(exact ? 'result' : 'results', selection, read.signal)
      if (!current()) return
      if (!value.ok) { this.failure(value.phase); return }
      if (exact) {
        const parsed = resultResponseSchema.safeParse(value.value)
        if (!parsed.success) { this.failure('unsupported'); return }
        const result = parsed.data
        if (!matches(selection, result) || result.resultId !== selection.resultId || result.revision !== selection.revision) { this.failure('failed'); return }
        this.view.update((state) => { state.result = result; state.phase = 'ready'; state.selection = {
          sessionId: result.sessionId, resultId: result.resultId, revision: result.revision, encounterRef: result.encounterRef,
        } })
      } else {
        const parsed = resultsResponseSchema.safeParse(value.value)
        if (!parsed.success) { this.failure('unsupported'); return }
        if (!matches(selection, parsed.data)) { this.failure('failed'); return }
        this.view.update((state) => { state.listing = parsed.data; state.phase = parsed.data.results.length === 0 ? 'empty' : 'choose' })
      }
    } catch (_requestFailed: unknown) {
      if (current() && !read.signal.aborted) this.failure('failed')
    } finally { if (this.read === read) this.read = null }
  }

  /**
   * Explicitly choose an immutable history entry; no newest-result selection is implicit.
   * @param ref - exact saved report revision.
   * @returns settlement of the selected read.
   */
  select(ref: ResultRef): Promise<void> {
    const { sessionId, resultId, revision, encounterRef } = ref
    return this.open({ sessionId, resultId, revision, ...(encounterRef === undefined ? {} : { encounterRef }) })
  }

  /**
   * Repeat the selected read to update progress without changing its revision.
   * @returns settlement of the metadata/report read.
   */
  refresh(): Promise<void> {
    const selection = this.view.getSnapshot().selection
    return selection === null ? Promise.resolve() : this.open(selection)
  }

  /**
   * Request one idempotent rerun; duplicate pending gestures share one request.
   * An uncertain admission keeps the old report visible and requires inspection before a new request.
   * @param requestId - stable caller-owned admission identity, or a fresh ID for a user gesture.
   * @returns settlement of admission, independently of analysis completion.
   */
  rerun(requestId: string = randomUUID()): Promise<RerunResponse | null> {
    if (this.pendingRerun !== null) return this.pendingRerun
    const state = this.view.getSnapshot(), result = state.result
    if (result === null || this.lifetime.signal.aborted || state.rerun === 'unknown') return Promise.resolve(null)
    const scope = this.scope, request = new AbortController()
    this.rerunRequest = request
    const current = (): boolean => scope === this.scope && !this.lifetime.signal.aborted
    this.view.update((value) => { value.rerun = 'pending' })
    const task = this.request('rerun', { sessionId: result.sessionId, resultId: result.resultId,
      revision: result.revision, encounterRef: result.encounterRef, requestId }, request.signal).then((value) => {
      if (!current()) return null
      if (!value.ok) {
        if (value.phase === 'login' || value.phase === 'denied') this.failure(value.phase)
        else this.view.update((next) => { next.rerun = value.phase === 'failed' ? 'unknown' : 'failed' })
        return null
      }
      const parsed = rerunResponseSchema.safeParse(value.value)
      if (!parsed.success || parsed.data.sessionId !== result.sessionId || parsed.data.requestId !== requestId) {
        this.view.update((next) => { next.rerun = 'unknown' }); return null
      }
      this.view.update((next) => { next.rerun = 'accepted' })
      return parsed.data
    }).catch((_requestFailed: unknown) => {
      if (current()) this.view.update((next) => { next.rerun = 'unknown' })
      return null
    }).finally(() => {
      if (this.pendingRerun === task) this.pendingRerun = null
      if (this.rerunRequest === request) this.rerunRequest = null
    })
    this.pendingRerun = task
    return task
  }

  /** Clear all patient content immediately, including while requests are unsettled. */
  clear(): void {
    this.generation++; this.scope++
    this.read?.abort(); this.read = null
    this.rerunRequest?.abort(); this.rerunRequest = null; this.pendingRerun = null
    this.view.set(empty)
  }
  /** Abort outstanding reads and prevent any further publication. */
  dispose(): void { this.clear(); this.lifetime.abort() }

  private failure(phase: ViewerPhase): void {
    this.view.update((state) => {
      state.phase = phase
      if (phase !== 'failed') { state.result = null; state.listing = null }
    })
  }

  private async request(
    operation: string, body: object, signal: AbortSignal,
  ): Promise<{ ok: true; value: unknown } | { ok: false; phase: ViewerPhase }> {
    const send = this.send
    const bounded = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const response = await send(`api/clinical-review/${operation}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: bounded })
    bounded.throwIfAborted()
    if (response.status === 401) return { ok: false, phase: 'login' }
    if (response.status === 403) return { ok: false, phase: 'denied' }
    if (response.status === 404) return { ok: false, phase: 'not-found' }
    if (response.status === 415 || response.status === 422) return { ok: false, phase: 'unsupported' }
    if (!response.ok) return { ok: false, phase: 'failed' }
    const result: unknown = await response.json()
    bounded.throwIfAborted()
    return { ok: true, value: result }
  }
}

function matches(selection: ResultSelection, value: Pick<ResultResponse, 'sessionId' | 'encounterRef'>): boolean {
  return selection.sessionId === value.sessionId && (selection.encounterRef === undefined || selection.encounterRef === value.encounterRef)
}
