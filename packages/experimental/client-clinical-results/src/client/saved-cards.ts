/** Saved-card confirmation waits for the authenticated reader to verify durable report acceptance. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { resultResponseSchema } from '@deepseek-ai/dsh-experimental-clinical-review/result'
import type { ViewerConfig } from '../types.ts'
import type { ResultRef } from './protocol.ts'
import type { ResultCardData } from './result-card.ts'

/** Only reports confirmed by the authorized saved-result reader may become result cards. */
export interface CardConfirmation {
  epoch: number
  confirmed: Partial<Record<string, ResultCardData>>
  unavailable: Partial<Record<string, boolean>>
}
/** One Session's cancellable saved-card read owner; raw acceptance events alone never publish cards. */
export class SavedCardController {
  /** Bare confirmation source for renderer-bound hooks. */
  readonly view = createSnapshotStore<CardConfirmation>({ epoch: 0, confirmed: {}, unavailable: {} })
  private scope = new AbortController()
  private readonly attempts = new Map<string, Promise<void>>()
  private disposed = false

  /**
   * @param config - authenticated reader timeout.
   * @param send - same-origin authenticated transport.
   */
  constructor(private readonly config: ViewerConfig, private readonly send: typeof fetch) {}

  /**
   * Confirm an exact raw-event reference after the server's report persistence operation settles.
   * @param ref - immutable report revision produced by the raw state record.
   * @param reportId - original immutable report identity to confirm.
   * @param retry - explicit user retry after an unavailable read.
   * @returns bounded read settlement; failed reads never publish a report card.
   */
  confirm(ref: ResultRef, reportId: string, retry = false): Promise<void> {
    if (this.disposed || this.view.getSnapshot().confirmed[reportId] !== undefined) return Promise.resolve()
    const existing = this.attempts.get(reportId)
    if (existing !== undefined && !retry) return existing
    const scope = this.scope, send = this.send
    const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const task = (async (): Promise<void> => {
      let confirmed: ResultCardData | undefined
      try { confirmed = await this.read(ref, reportId, signal, send) }
      catch (_unavailableRead: unknown) { /* A failed or cancelled read cannot establish durable report acceptance. */ }
      if (this.disposed || scope !== this.scope) return
      this.view.update((state) => {
        if (confirmed === undefined) state.unavailable[reportId] = true
        else { state.confirmed[reportId] = confirmed; state.unavailable[reportId] = false }
      })
    })()
    this.attempts.set(reportId, task)
    return task
  }

  private async read(ref: ResultRef, reportId: string, signal: AbortSignal, send: typeof fetch): Promise<ResultCardData | undefined> {
    const response = await send('api/clinical-review/result', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(ref), signal })
    signal.throwIfAborted()
    if (!response.ok) return undefined
    const parsed = resultResponseSchema.safeParse(await response.json())
    signal.throwIfAborted()
    if (!parsed.success) return undefined
    const result = parsed.data
    if (result.sessionId !== ref.sessionId || result.resultId !== ref.resultId || result.revision !== ref.revision
      || result.reportId !== reportId || (ref.encounterRef !== undefined && result.encounterRef !== ref.encounterRef)) return undefined
    return { ref: { sessionId: result.sessionId, resultId: result.resultId, revision: result.revision, encounterRef: result.encounterRef },
      reportId: result.reportId, encounterLabel: result.encounterLabel, generatedAt: result.generatedAt,
      findingCount: result.findingCount, coverageGaps: result.snapshotStatus === 'unavailable' ? null
        : result.coverage.filter(item => item.status === 'unread' || item.status === 'unsupported').length }
  }

  /** Drop clinical metadata and invalidate pending confirmations after account or connection changes. */
  clear(): void {
    this.scope.abort(); this.scope = new AbortController(); this.attempts.clear()
    const epoch = this.view.getSnapshot().epoch + 1
    this.view.set({ epoch, confirmed: {}, unavailable: {} })
  }
  /** Cancel owned reads and permanently stop publication. */
  dispose(): void { this.disposed = true; this.clear(); this.scope.abort() }
}
