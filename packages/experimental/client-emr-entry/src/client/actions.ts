/** Bounded browser actions and notices; clinical evidence stays in the Session. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter/wire'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EntryConfig } from '../types.ts'
import { receipt, reviewFailure, reviewStatus } from './protocol.ts'

/** Transient view state shared by the entry actions and their persistent overlay. */
export interface EntryView {
  open: boolean
  sessionId: SessionId | null
  busy: boolean
  notice: 'opened' | 'reviewAccepted' | 'refreshed' | 'failed' | null
  sequence: number
  statusPhase: 'idle' | 'loading' | 'ready' | 'unbound' | 'denied' | 'unavailable'
  status: ReturnType<typeof reviewStatus.parse> | null
}

/** Browser entry requests own cancellation and contain every asynchronous failure. */
export class EntryActions {
  /** No patient fields or clinical report content are retained in this view snapshot. */
  readonly view = createSnapshotStore<EntryView>({ open: false, sessionId: null, busy: false, notice: null, sequence: 0, statusPhase: 'idle', status: null })
  private readonly lifetime = new AbortController()
  private readonly pending = new Map<string, { operation: string; body: string; promise: Promise<ReturnType<typeof receipt.parse>> }>()
  private navigation = 0
  private statusRequest: AbortController | null = null
  private readonly statusPending = new Set<Promise<void>>()

  /**
   * @param config - public deployment settings.
   * @param send - same-origin HTTP transport, invoked without a receiver.
   * @param openSession - existing workspace navigation.
   */
  constructor(
    private readonly config: EntryConfig,
    private readonly send: typeof fetch,
    private readonly openSession: (id: SessionId) => void,
  ) {}

  /**
   * Open the entry form or the current Session review controls.
   * @param sessionId - current Session; omission opens encounter entry.
   */
  show(sessionId: SessionId | null = null): void {
    if (this.lifetime.signal.aborted) return
    this.navigation++
    this.cancelStatus()
    this.view.update((value) => { value.open = true; value.sessionId = sessionId; value.status = null; value.statusPhase = 'idle' })
    if (sessionId !== null) void this.updateStatus()
  }
  /** Close the form without changing a bound encounter or cancelling accepted work. */
  close(): void {
    this.navigation++
    this.cancelStatus()
    this.view.update((value) => { value.open = false; value.status = null; value.statusPhase = 'idle' })
  }
  /** Dismiss the current operation notice. */
  dismiss(): void { this.view.update((value) => { value.notice = null }) }
  /**
   * Admit one identifier-only launch through server authorization.
   * @param claim - context claimed by a user or accepted window.
   * @returns metadata receipt after server authorization.
   */
  launch(claim: LaunchClaim): Promise<ReturnType<typeof receipt.parse>> { return this.request('launch', claim, 'opened') }
  /**
   * Request evidence capture and analysis for a bound Session.
   * @param sessionId - addressed private Session.
   * @returns completion of asynchronous review admission.
   */
  async review(sessionId: SessionId): Promise<void> {
    await this.request('review', { sessionId, eventId: randomUUID(), trigger: 'manual-review' }, 'reviewAccepted')
  }
  /**
   * Refresh evidence without requesting model analysis.
   * @param sessionId - addressed private Session.
   * @returns completion of evidence-refresh admission.
   */
  async refresh(sessionId: SessionId): Promise<void> {
    await this.request('refresh', { sessionId, eventId: randomUUID() }, 'refreshed')
  }

  /** Read metadata for the open encounter controls without capturing evidence or waking the model.
   * @returns Completion of this bounded read; failures are contained in the current view.
   */
  updateStatus(): Promise<void> {
    const { open, sessionId } = this.view.getSnapshot()
    if (!open || sessionId === null || this.lifetime.signal.aborted) return Promise.resolve()
    this.cancelStatus()
    const controller = new AbortController()
    this.statusRequest = controller
    this.view.update((value) => { value.statusPhase = 'loading' })
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const current = (): boolean => this.statusRequest === controller && !controller.signal.aborted && !this.lifetime.signal.aborted
      && this.view.getSnapshot().open && this.view.getSnapshot().sessionId === sessionId
    const task = this.readStatus(sessionId, signal).then((result) => {
      if (!current()) return
      this.view.update((value) => {
        value.statusPhase = typeof result === 'string' ? result : 'ready'
        if (typeof result !== 'string') value.status = result
        else if (result !== 'unavailable') value.status = null
      })
    }).catch((_error: unknown) => {
      if (current()) this.view.update((value) => { value.statusPhase = 'unavailable' })
    }).finally(() => {
      this.statusPending.delete(task)
      if (this.statusRequest === controller) this.statusRequest = null
    })
    this.statusPending.add(task)
    return task
  }

  private cancelStatus(): void {
    this.statusRequest?.abort()
    this.statusRequest = null
  }

  private async readStatus(sessionId: SessionId, signal: AbortSignal): Promise<ReturnType<typeof reviewStatus.parse> | 'unbound' | 'denied' | 'unavailable'> {
    const send = this.send
    const response = await send('api/clinical-review/status', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }), signal,
    })
    signal.throwIfAborted()
    if (response.status === 401 || response.status === 403) return 'denied'
    const body: unknown = await response.json()
    signal.throwIfAborted()
    if (!response.ok) {
      const failure = reviewFailure.safeParse(body)
      return failure.success && failure.data.error.code === 'unbound-session' ? 'unbound' : 'unavailable'
    }
    const result = reviewStatus.parse(body)
    if (result.sessionId !== sessionId) throw new Error('EMR_STATUS_SESSION_MISMATCH')
    return result
  }

  private request(
    operation: 'launch' | 'review' | 'refresh',
    input: LaunchClaim | { sessionId: SessionId; eventId: string; trigger?: 'manual-review' },
    notice: 'opened' | 'reviewAccepted' | 'refreshed',
  ): Promise<ReturnType<typeof receipt.parse>> {
    const body = JSON.stringify(input)
    const existing = this.pending.get(input.eventId)
    if (existing !== undefined && existing.body === body && existing.operation === operation) return existing.promise
    if (existing !== undefined || this.pending.size >= this.config.maxPendingRequests || this.lifetime.signal.aborted) {
      this.report('failed')
      return Promise.reject(new Error('EMR_ENTRY_BUSY'))
    }
    const navigation = ++this.navigation
    this.view.update((value) => { value.busy = true })
    const promise = this.perform(operation, body).then((result) => {
      if (navigation === this.navigation && !this.lifetime.signal.aborted) {
        this.openSession(result.sessionId as SessionId)
        this.close()
        this.report(notice)
      }
      return result
    }).catch((error: unknown) => { if (navigation === this.navigation) this.report('failed'); throw error }).finally(() => {
      this.pending.delete(input.eventId)
      this.view.update((value) => { value.busy = this.pending.size > 0 })
    })
    this.pending.set(input.eventId, { operation, body, promise })
    return promise
  }

  private async perform(operation: string, body: string): Promise<ReturnType<typeof receipt.parse>> {
    const send = this.send
    const response = await send(`api/clinical-review/${operation}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body,
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
    })
    if (!response.ok) throw new Error('EMR_ENTRY_REJECTED')
    const result = receipt.parse(await response.json())
    this.lifetime.signal.throwIfAborted()
    return result
  }

  private report(notice: EntryView['notice']): void {
    if (!this.lifetime.signal.aborted) this.view.update((value) => { value.notice = notice; value.sequence++ })
  }

  /** Cancel local waits and settle every admitted request without cancelling discharge. @returns quiescent completion. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.cancelStatus()
    await Promise.allSettled([...this.pending.values()].map(value => value.promise))
    await Promise.allSettled(this.statusPending)
  }
}
