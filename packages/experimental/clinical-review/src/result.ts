/** Browser-safe saved-result requests and versioned, immutable report views. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One logical review result within its owning Session. */
export type ClinicalResultId = Branded<'ClinicalResultId'>
/** Opaque reference to the verified source system, hospital, and inpatient identity. */
export type ClinicalEncounterRef = Branded<'ClinicalEncounterRef'>
/** One finding instance in an immutable result revision. */
export type ClinicalFindingId = Branded<'ClinicalFindingId'>
const text = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const sessionId = text.transform(brandString<SessionId>)
const resultId = text.transform(brandString<ClinicalResultId>)
const encounterRef = text.transform(brandString<ClinicalEncounterRef>)

/** Saved-result listing never starts a model turn or source capture. */
export const resultsRequestSchema = z.strictObject({ sessionId, encounterRef: encounterRef.optional() })
/** Exact saved revision; the optional encounter reference must match when supplied. */
export const resultRequestSchema = z.strictObject({ sessionId, resultId,
  revision: z.number().int().positive(), encounterRef: encounterRef.optional() })
/** Explicit review admission, with the selected immutable revision in its retry identity. */
export const rerunRequestSchema = resultRequestSchema.extend({ encounterRef, requestId: text })
/** Source metadata belongs to the retained historical snapshot, never the current EMR record. */
export const resultEvidenceSchema = z.strictObject({
  sourceRef: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1),
  source: z.strictObject({ sourceId: z.string(), sourceRevision: z.string(), category: z.string(), state: z.string(),
    occurredAt: z.string().nullable(), availableAt: z.string().nullable() }).nullable(),
  sourceStatus: z.enum(['retained', 'unavailable']),
})
/** Legacy classifications remain readable without inventing semantic rule or field keys. */
export const resultFindingSchema = z.strictObject({
  findingId: z.string().transform(brandString<ClinicalFindingId>), kind: z.enum(['inconsistency', 'missing-information', 'needs-verification']),
  issueCode: z.enum(['inconsistency', 'missing-information', 'needs-verification']).nullable(), legacy: z.literal(true), fieldKey: z.null(), title: z.string(), explanation: z.string(), suggestion: z.string(),
  evidenceRefs: z.array(resultEvidenceSchema),
})
/** Progress is independent of the immutable report selected by a viewer. */
export const resultProgressSchema = z.strictObject({
  revision: z.number().int().nonnegative(), status: z.enum(['bound', 'collecting', 'reviewing', 'reviewed', 'stale', 'failed', 'cancelled']),
  errorCode: z.string().nullable(),
})
/** Only explicit later captures compare the complete accepted inventory and its coverage. */
export const resultFreshnessSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unknown'), lastCheckedAt: z.null(), scope: z.literal('none') }),
  z.strictObject({ status: z.enum(['unchanged', 'changed']), lastCheckedAt: z.string(), scope: z.literal('accepted-snapshot') }),
])
/** Stable selector and card metadata for one accepted report. */
export const resultSummarySchema = z.strictObject({
  sessionId, encounterRef, resultId, revision: z.number().int().positive(), reportId: z.string().min(1),
  generatedAt: z.string().nullable(), findingCount: z.number().int().nonnegative(), evidenceRevision: z.string(),
  capturedAt: z.string().nullable(), cutoff: z.string().nullable(), legacy: z.literal(true),
})
const base = z.strictObject({ schemaVersion: z.literal(1), resultType: z.literal('pre-discharge-review'), sessionId, encounterRef,
  encounterLabel: z.string(), progress: resultProgressSchema, freshness: resultFreshnessSchema, dischargeBlocked: z.literal(false) })
/** Authorized newest-first saved report references, including an empty result set. */
export const resultsResponseSchema = base.extend({ results: z.array(resultSummarySchema) })
/** Full saved report, exact quotations, declared coverage, and separate calculation limits. */
export const resultResponseSchema = base.extend({
  resultId, revision: z.number().int().positive(), reportId: z.string(), generatedAt: z.string().nullable(),
  evidenceRevision: z.string(), capturedAt: z.string().nullable(), cutoff: z.string().nullable(),
  summary: z.string(), findingCount: z.number().int().nonnegative(), findings: z.array(resultFindingSchema), assessment: z.literal('pending-human-review'),
  coverage: z.array(z.strictObject({ category: z.string(), status: z.enum(['complete', 'empty', 'unsupported', 'unread']), detail: z.string().optional() })),
  snapshotStatus: z.enum(['retained', 'unavailable']), reviewedSourceRefs: z.array(z.string()), unreviewedSourceRefs: z.array(z.string()),
  calculation: z.strictObject({ drg: z.strictObject({ status: z.literal('unavailable'), reason: z.literal('engine-unavailable') }),
    dip: z.strictObject({ status: z.literal('unavailable'), reason: z.literal('engine-unavailable') }) }),
  history: z.array(resultSummarySchema), latestRevision: z.number().int().positive(), legacy: z.literal(true),
})
/** Durable rerun acknowledgment; revision identifies admission rather than a completed report. */
export const rerunResponseSchema = z.strictObject({ sessionId, revision: z.number().int().positive(),
  status: z.enum(['accepted', 'duplicate']), dischargeBlocked: z.literal(false), requestId: text })
/** Saved-results listing request. */
export type ResultsRequest = z.infer<typeof resultsRequestSchema>
/** Exact report request. */
export type ResultRequest = z.infer<typeof resultRequestSchema>
/** Idempotent explicit rerun request. */
export type RerunRequest = z.infer<typeof rerunRequestSchema>
/** Authorized saved-report references. */
export type ResultsResponse = z.infer<typeof resultsResponseSchema>
/** Complete saved clinical report view. */
export type ResultResponse = z.infer<typeof resultResponseSchema>
/** One saved report selector. */
export type ResultSummary = z.infer<typeof resultSummarySchema>
/** Durable rerun receipt. */
export type RerunResponse = z.infer<typeof rerunResponseSchema>

/** Derive the stable logical result identity from its server-owned Session.
 * @param id - Owning Session identity.
 * @returns Opaque logical result identity; accepted report revisions share it.
 */
export function resultIdForSession(id: string): ClinicalResultId { return brandString<ClinicalResultId>(`clinical-result:${id}`) }
