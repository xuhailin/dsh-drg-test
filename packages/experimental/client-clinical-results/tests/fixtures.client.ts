/** Synthetic saved clinical results; no patient or external service data. */
import { resultResponseSchema, resultSummarySchema } from '@deepseek-ai/dsh-experimental-clinical-review/result'
import type { ViewerConfig } from '../src/types.ts'
import { resultSelectionSchema, type ResultRef } from '../src/client/protocol.ts'

export const config: ViewerConfig = { allowedOrigins: [], requestTimeoutMs: 1000, maxMessageBytes: 8192,
  maxPendingRequests: 4, maxActionReceipts: 256, directoryPageSize: 20 }
export const reference = resultSelectionSchema.parse({ sessionId: 'synthetic-session', resultId: 'clinical-result:synthetic-session', revision: 1, encounterRef: 'synthetic-binding' }) as ResultRef
export const summary = resultSummarySchema.parse({ ...reference, reportId: 'report-1', generatedAt: '2026-10-23T01:00:00.000Z',
  findingCount: 1, evidenceRevision: 'evidence-old', capturedAt: '2026-10-23T00:00:00.000Z', cutoff: '2026-10-22T23:00:00.000Z', legacy: true })
export const result = resultResponseSchema.parse({ schemaVersion: 1, resultType: 'pre-discharge-review', ...reference,
  encounterLabel: 'Synthetic encounter', progress: { revision: 2, status: 'failed', errorCode: 'source-unavailable' },
  freshness: { status: 'unknown', lastCheckedAt: null, scope: 'none' }, dischargeBlocked: false,
  reportId: summary.reportId, generatedAt: summary.generatedAt, evidenceRevision: summary.evidenceRevision,
  capturedAt: summary.capturedAt, cutoff: summary.cutoff,
  summary: 'Synthetic review summary', findingCount: 1, findings: [{ findingId: 'finding-1', kind: 'needs-verification', issueCode: 'needs-verification', legacy: true,
    fieldKey: null, title: 'Synthetic finding', explanation: 'Verify the documented inconsistency', suggestion: 'Review the source record',
    evidenceRefs: [{ sourceRef: 'source-old', start: 2, end: 15, quote: 'Exact\nquotation', source: { sourceId: 'document-1', sourceRevision: 'revision-old',
      category: 'documents', state: 'signed', occurredAt: '2026-10-21', availableAt: '2026-10-22' }, sourceStatus: 'retained' }] }],
  assessment: 'pending-human-review', coverage: [{ category: 'documents', status: 'complete' }, { category: 'labs', status: 'unread', detail: 'Synthetic retrieval gap' }, { category: 'checks', status: 'unsupported' }],
  snapshotStatus: 'retained', reviewedSourceRefs: ['source-old'], unreviewedSourceRefs: ['unreviewed-source'],
  calculation: { drg: { status: 'unavailable', reason: 'engine-unavailable' }, dip: { status: 'unavailable', reason: 'engine-unavailable' } },
  history: [{ ...summary, revision: 2, reportId: 'report-2' }, summary], latestRevision: 2, legacy: true,
})
export const listing = { schemaVersion: result.schemaVersion, resultType: result.resultType, sessionId: result.sessionId,
  encounterRef: result.encounterRef,
  encounterLabel: result.encounterLabel, progress: result.progress, freshness: result.freshness,
  dischargeBlocked: false as const, results: result.history }
