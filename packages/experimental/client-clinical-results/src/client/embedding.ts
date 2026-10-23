/** Reference-only embedding handshake and action receipts for one authenticated viewer. */
import { z } from 'zod'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { launchClaimSchema } from '@deepseek-ai/dsh-experimental-emr-encounter/wire'
import type { LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter/wire'
import type { ViewerConfig } from '../types.ts'
import { resultSelectionSchema, type ResultSelection } from './protocol.ts'

const id = z.string().min(1).max(256)
const base = { protocolVersion: z.literal(1), viewId: id, requestId: id }
const connect = z.strictObject({
  type: z.literal('dsh.results.connect'), ...base, accountRef: id,
  capabilities: z.array(z.enum(['emr.open_record', 'emr.focus_field', 'emr.open_section'])).max(3),
  selection: resultSelectionSchema.optional(),
  launch: launchClaimSchema.refine(value => value.trigger === 'open').optional(),
}).refine(value => !(value.selection !== undefined && value.launch !== undefined))
const select = z.strictObject({
  type: z.literal('dsh.results.select'), ...base, accountRef: id, selection: resultSelectionSchema,
})
const clear = z.strictObject({ type: z.literal('dsh.results.clear'), ...base })
const action = z.strictObject({
  type: z.literal('dsh.results.action'), ...base, accountRef: id,
  selection: resultSelectionSchema.refine(value => value.resultId !== undefined && value.revision !== undefined),
  actionKey: z.literal('review.rerun'),
})
const message = z.union([connect, select, clear, action])

/** Actions remain bound to the selected immutable result; no clinical bodies cross the window. */
export interface EmbeddingCallbacks {
  /** Load one reference through the authenticated result API.
   * @param selection - Addressed result or encounter Session.
   * @returns Completion of the read.
   */
  open(this: void, selection: ResultSelection): Promise<void>
  /** Bind an encounter without collecting evidence or waking a model.
   * @param claim - Open-only launch claim.
   * @param signal - View lifetime.
   * @returns Authorized Session selection.
   */
  launch(this: void, claim: LaunchClaim, signal: AbortSignal): Promise<ResultSelection>
  /** Remove cached clinical content and cancel the previous selection. */
  clear(this: void): void
  /** Request a fresh review of the current result.
   * @param selection - Expected immutable selection.
   * @param requestId - Stable deduplication ID.
   * @returns Admission receipt only, without clinical fields.
   */
  rerun(this: void, selection: ResultSelection, requestId: string): Promise<{ status: string; revision: number } | null>
  /** Read the view's actual selected immutable report. @returns Exact current selection or null. */
  selection(this: void): ResultSelection | null
  /** Recheck a cached action's read permission without executing the action.
   * @param selection - Exact currently selected report.
   * @returns True only after a fresh authenticated read succeeds.
   */
  authorize(this: void, selection: ResultSelection): Promise<boolean>
}

/** Correlated, nonclinical outcome returned to the opening window. */
export interface EmbeddingReceipt {
  readonly type: 'dsh.results.receipt'
  readonly protocolVersion: 1
  readonly viewId: string
  readonly requestId: string
  readonly status: 'completed' | 'accepted' | 'unsupported' | 'rejected' | 'cancelled' | 'failed' | 'unknown'
  readonly reason?: string
}

interface RetainedRequest { readonly fingerprint: string; readonly result: Promise<EmbeddingReceipt> }
interface Peer { source: Window; origin: string; accountRef: string; initialRequest: string; ready: boolean; lifetime: AbortController }

/** One iframe load owns one handshake challenge and bounded receipt ledger. */
export class ResultEmbedding {
  private viewId = randomUUID()
  private peer: Peer | null = null
  private readonly receipts = new Map<string, RetainedRequest>()
  private selected: ResultSelection | null = null
  private started = false
  private stopped = false
  private readonly sources: Window[]
  /**
   * @param config - Exact trusted origins and bounded request retention.
   * @param callbacks - View-owned reads and allowed actions.
   * @param surface - Browser window; tests may supply a separate jsdom window.
   */
  constructor(private readonly config: ViewerConfig, private readonly callbacks: EmbeddingCallbacks,
    private readonly surface: Window = window) {
    const opener = (surface.opener as Window | null | undefined) ?? null
    this.sources = [surface.parent === surface ? null : surface.parent, opener]
      .filter((source): source is Window => source !== null)
  }

  /** Install the window listener and announce a fresh challenge.
   * @returns Idempotent listener and view disposer.
   */
  start(): () => void {
    if (this.started || this.stopped) throw new Error('Result embedding already started or disposed.')
    this.started = true
    this.surface.addEventListener('message', this.listener)
    this.ready()
    return () => { this.dispose() }
  }

  /** Validate and process one message from the exact allowed parent or opener.
   * @param event - Untrusted browser message.
   * @returns Completion of the correlated receipt, when a message is valid.
   */
  async receive(event: Pick<MessageEvent<unknown>, 'data' | 'origin' | 'source'>): Promise<void> {
    if (this.stopped || !this.config.allowedOrigins.includes(event.origin)) return
    const source = this.sources.find(candidate => candidate === event.source)
    if (source === undefined) return
    let bytes: number
    try { bytes = new TextEncoder().encode(JSON.stringify(event.data)).byteLength }
    catch (_unserializableMessage) { return }
    if (bytes > this.config.maxMessageBytes) return
    const parsed = message.safeParse(event.data)
    if (!parsed.success || parsed.data.viewId !== this.viewId) return
    const request = parsed.data
    if (request.type === 'dsh.results.clear') {
      if (this.peer?.source !== source || this.peer.origin !== event.origin) return
      const receipt = this.receipt(request.requestId, 'completed')
      this.reset()
      this.post(source, event.origin, receipt)
      this.ready()
      return
    }
    if (request.type === 'dsh.results.connect') {
      if (this.peer !== null && (this.peer.source !== source || this.peer.origin !== event.origin
        || this.peer.accountRef !== request.accountRef
        || this.peer.initialRequest !== JSON.stringify(request))) {
        this.reset()
        this.ready()
        return
      }
      if (this.peer === null) {
        this.callbacks.clear()
        this.peer = { source, origin: event.origin, accountRef: request.accountRef,
          initialRequest: JSON.stringify(request), ready: false, lifetime: new AbortController() }
      }
    }
    const peer = this.peer
    if (peer === null || peer.source !== source || peer.origin !== event.origin || peer.accountRef !== request.accountRef) return
    if ((request.type === 'dsh.results.select' || request.type === 'dsh.results.connect') && request.selection !== undefined
      && this.selected !== null && (request.selection.sessionId !== this.selected.sessionId
        || request.selection.encounterRef !== this.selected.encounterRef)) {
      const receipt = this.receipt(request.requestId, 'cancelled', 'handshake-required')
      this.reset()
      this.post(source, event.origin, receipt)
      this.ready()
      return
    }
    if (request.type === 'dsh.results.select' && !peer.ready) {
      const receipt = this.receipt(request.requestId, 'cancelled', 'handshake-required')
      this.reset()
      this.post(source, event.origin, receipt)
      this.ready()
      return
    }
    const fingerprint = JSON.stringify(request)
    const retained = this.receipts.get(request.requestId)
    if (retained !== undefined) {
      let receipt: EmbeddingReceipt
      if (retained.fingerprint !== fingerprint) receipt = this.receipt(request.requestId, 'rejected', 'conflicting-request')
      else if (request.type === 'dsh.results.action') {
        const current = this.callbacks.selection()
        receipt = current !== null && sameSelection(current, request.selection) && await this.callbacks.authorize(request.selection)
          ? await retained.result : this.receipt(request.requestId, 'rejected', 'authorization-required')
      } else receipt = await retained.result
      if (this.peer === peer && !peer.lifetime.signal.aborted) this.post(source, event.origin, receipt)
      return
    }
    if (this.receipts.size >= this.config.maxActionReceipts) {
      this.post(source, event.origin, this.receipt(request.requestId, 'rejected', 'receipt-capacity'))
      return
    }
    const outstanding = [...this.receipts.values()].filter(value => !this.settled.has(value)).length
    if (outstanding >= this.config.maxPendingRequests) {
      this.post(source, event.origin, this.receipt(request.requestId, 'rejected', 'request-capacity'))
      return
    }
    const result = this.perform(request, peer)
    const record = { fingerprint, result }
    this.receipts.set(request.requestId, record)
    const receipt = await result
    if (request.type === 'dsh.results.connect') peer.ready = true
    this.settled.add(record)
    if (this.peer === peer && !peer.lifetime.signal.aborted) this.post(source, event.origin, receipt)
  }

  private readonly settled = new WeakSet<RetainedRequest>()
  private readonly listener = (event: MessageEvent<unknown>): void => {
    void this.receive(event).catch((_error: unknown) => { this.reset(); this.ready() })
  }

  private async perform(request: z.infer<typeof message>, peer: Peer): Promise<EmbeddingReceipt> {
    const requestId = request.requestId
    try {
      if (request.type === 'dsh.results.clear') return this.receipt(requestId, 'rejected')
      if (request.type === 'dsh.results.connect' || request.type === 'dsh.results.select') {
        let selection = request.selection
        if (request.type === 'dsh.results.connect' && request.launch !== undefined) {
          this.callbacks.clear()
          selection = await this.callbacks.launch(request.launch, peer.lifetime.signal)
        }
        if (peer.lifetime.signal.aborted) return this.receipt(requestId, 'cancelled')
        if (selection !== undefined) {
          this.selected = selection
          await this.callbacks.open(selection)
        }
        return this.receipt(requestId, 'completed')
      }
      const selected = this.callbacks.selection()
      if (selected === null || !sameSelection(selected, request.selection)) return this.receipt(requestId, 'rejected', 'selection-mismatch')
      const result = await this.callbacks.rerun(request.selection, requestId)
      return this.receipt(requestId, result === null ? 'failed' : 'accepted')
    } catch (_operationFailure) {
      return this.receipt(requestId, peer.lifetime.signal.aborted ? 'cancelled' : 'unknown', 'check-current-view')
    }
  }

  private receipt(requestId: string, status: EmbeddingReceipt['status'], reason?: string): EmbeddingReceipt {
    return { type: 'dsh.results.receipt', protocolVersion: 1, viewId: this.viewId, requestId, status, ...(reason === undefined ? {} : { reason }) }
  }
  private post(source: Window, origin: string, value: object): void {
    try { source.postMessage(value, origin) }
    catch (_closedWindow) { /* A closed host cannot receive receipts; local saved results remain readable. */ }
  }
  private ready(): void {
    if (this.stopped) return
    for (const source of this.sources) for (const origin of this.config.allowedOrigins) {
      this.post(source, origin, { type: 'dsh.results.ready', protocolVersion: 1, viewId: this.viewId })
    }
  }
  private reset(clearView = true): void {
    this.peer?.lifetime.abort()
    this.peer = null
    this.selected = null
    this.receipts.clear()
    this.viewId = randomUUID()
    if (clearView) this.callbacks.clear()
  }
  /** Retire the handshake after the result owner has already cleared data on authorization failure. */
  authorizationLost(): void {
    const peer = this.peer, viewId = this.viewId
    this.reset(false)
    if (peer !== null) this.post(peer.source, peer.origin, {
      type: 'dsh.results.closed', protocolVersion: 1, viewId, reason: 'authorization-required',
    })
  }
  /** Invalidate all in-flight responses on authentication loss or view destruction. */
  invalidate(): void { this.reset(); this.ready() }
  /** Remove listeners, clear old patient content, and retire this view permanently. */
  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    this.surface.removeEventListener('message', this.listener)
    this.reset()
  }
}

function sameSelection(left: ResultSelection, right: ResultSelection): boolean {
  return left.sessionId === right.sessionId && left.encounterRef === right.encounterRef
    && left.resultId === right.resultId && left.revision === right.revision
}
