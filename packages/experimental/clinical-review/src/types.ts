/** Session-owned evidence, review proposals, and asynchronous admission receipts. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CaseRevision, EncounterBinding, EncounterSnapshot } from '@deepseek-ai/dsh-experimental-emr-encounter'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Exact source quotation; offsets are UTF-16 code units in the accepted source content. */
export interface ReviewCitation { readonly sourceRef: string; readonly start: number; readonly end: number; readonly quote: string }
/** Model-proposed issue requiring clinician assessment, never an approved clinical fact. */
export interface ReviewFinding {
  readonly kind: 'inconsistency' | 'missing-information' | 'needs-verification'
  readonly title: string
  readonly explanation: string
  readonly suggestion: string
  readonly citations: readonly ReviewCitation[]
}
/** Content-derived immutable review report identity. */
export type ReviewReportId = Branded<'ClinicalReviewReportId'>
/** Immutable model-proposed report at one accepted evidence revision. */
export interface ReviewReport {
  readonly reportId: ReviewReportId
  readonly revision: number
  readonly caseRevision: CaseRevision
  readonly summary: string
  readonly findings: readonly ReviewFinding[]
  readonly reviewedSourceRefs: readonly string[]
  readonly assessment: 'pending-human-review'
  readonly calculation: { readonly drg: 'unavailable'; readonly dip: 'unavailable' }
}
/** Durable event admission and its last known outcome; repeated IDs do not redispatch. */
export interface ReviewOperation {
  readonly eventId: string
  readonly trigger: 'manual-review' | 'discharge-order' | 'refresh'
  readonly status: 'accepted' | 'dispatched' | 'refreshed' | 'failed' | 'cancelled'
  readonly revision: number
  readonly errorCode?: string | undefined
}
/** Complete business after-state carried by each state record. */
export interface ReviewState {
  readonly schemaVersion: 1
  readonly ownerSessionId: SessionId
  readonly caseRef: string
  readonly binding: EncounterBinding
  readonly revision: number
  readonly status: 'bound' | 'collecting' | 'reviewing' | 'reviewed' | 'stale' | 'failed' | 'cancelled'
  readonly snapshot: EncounterSnapshot | null
  readonly report: ReviewReport | null
  readonly readRanges: readonly { readonly sourceRef: string; readonly start: number; readonly end: number }[]
  readonly history: readonly ReviewReport[]
  readonly operations: readonly ReviewOperation[]
}
/** Accepted metadata only; discharge completion never depends on this receipt. */
export interface ReviewReceipt {
  readonly sessionId: SessionId
  readonly revision: number
  readonly status: 'bound' | 'accepted' | 'duplicate'
  readonly dischargeBlocked: false
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Complete encounter review state, including binding, accepted evidence, read ranges, proposals, and durable event outcomes. */
    'plugin:clinical-review/state': ReviewState
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { clinicalReview: ReviewState | null }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'clinical-review-trigger': { kind: 'clinical-review-trigger'; eventId: string; revision: number }
  }
}
