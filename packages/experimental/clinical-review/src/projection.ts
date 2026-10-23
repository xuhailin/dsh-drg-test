/** Pure validated projection of complete review state; no credentials or source reads. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CaseRevision } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { bindingSchema, snapshotSchema, parseBinding, parseSnapshot } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SubmitFindings } from './state.ts'
import type { ReviewFinding, ReviewReport, ReviewReportId, ReviewState } from './types.ts'

/** Citation offsets must describe a nonempty exact quotation. */
export const citationSchema = z.strictObject({
  sourceRef: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1),
}).refine(value => value.end > value.start)
/** Model JSON is validated before evidence membership checks. */
export const findingSchema: z.ZodType<ReviewFinding> = z.strictObject({
  kind: z.enum(['inconsistency', 'missing-information', 'needs-verification']),
  title: z.string().min(1).max(300), explanation: z.string().min(1).max(4000), suggestion: z.string().min(1).max(2000),
  citations: z.array(citationSchema).max(20),
})
/** Validate complete model proposals before writing any Session record. */
export const proposalSchema: z.ZodType<SubmitFindings> = z.strictObject({
  revision: z.number().int().positive(), caseRevision: z.string().min(1), summary: z.string().min(1).max(8000),
  findings: z.array(findingSchema), reviewedSourceRefs: z.array(z.string().min(1)),
})
/** A report remains a model proposal until a separate clinical process acts on it. */
export const reportSchema: z.ZodType<ReviewReport> = z.strictObject({
  reportId: z.string().min(1).transform(brandString<ReviewReportId>), revision: z.number().int().positive(),
  caseRevision: z.string().min(1).transform(brandString<CaseRevision>),
  summary: z.string().min(1).max(8000), findings: z.array(findingSchema), reviewedSourceRefs: z.array(z.string().min(1)),
  assessment: z.literal('pending-human-review'), calculation: z.strictObject({ drg: z.literal('unavailable'), dip: z.literal('unavailable') }),
})
/** Durable records are validated on every replay, including restored and forked histories. */
export const stateSchema: z.ZodType<ReviewState> = z.strictObject({
  schemaVersion: z.literal(1), ownerSessionId: z.string().min(1).transform(SessionId), caseRef: z.string().min(1),
  binding: bindingSchema.transform(parseBinding),
  revision: z.number().int().nonnegative(), status: z.enum(['bound', 'collecting', 'reviewing', 'reviewed', 'stale', 'failed', 'cancelled']),
  snapshot: snapshotSchema.transform(parseSnapshot).nullable(), report: reportSchema.nullable(), history: z.array(reportSchema),
  readRanges: z.array(z.strictObject({ sourceRef: z.string().min(1),
    start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })),
  operations: z.array(z.strictObject({
    eventId: z.string().min(1), trigger: z.enum(['manual-review', 'discharge-order', 'refresh']),
    status: z.enum(['accepted', 'dispatched', 'refreshed', 'failed', 'cancelled']), revision: z.number().int().nonnegative(), errorCode: z.string().optional(),
  })),
})
/** Host-only projection retains original Session identity so forks cannot inherit read authority. */
export const reviewProjection: ProjectionDefinition<'clinicalReview'> = {
  key: 'clinicalReview', stateVersion: 1, stateSchema: stateSchema.nullable(), init: () => null,
  apply(state, event) {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:clinical-review/state' ? stateSchema.parse(record.data) : state
  },
}
