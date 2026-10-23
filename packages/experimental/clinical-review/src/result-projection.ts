/** Historical report/snapshot associations recovered incrementally from complete plugin records. */
import { z } from 'zod'
import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { snapshotSchema, parseSnapshot } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { reportSchema, stateSchema } from './projection.ts'

const retainedReportSchema = z.strictObject({ report: reportSchema, snapshot: snapshotSchema.transform(parseSnapshot).nullable(),
  generatedAt: z.string().nullable() })
/** Accepted reports retain their original source snapshot after refresh and restart. */
export type RetainedReviewReport = z.infer<typeof retainedReportSchema>
const retainedStateSchema = z.strictObject({ ownerSessionId: z.string().transform(SessionId), reports: z.array(retainedReportSchema),
  latestCapture: z.strictObject({ revision: z.number().int().positive(), snapshot: snapshotSchema.transform(parseSnapshot) }).nullable() })
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { clinicalResults: z.infer<typeof retainedStateSchema> }
}

/** Replay builds a read-only history without changing the persisted review record format. */
export const resultProjection: ProjectionDefinition<'clinicalResults'> = {
  key: 'clinicalResults', stateVersion: 1, stateSchema: retainedStateSchema, init: header => ({ ownerSessionId: header.id, reports: [], latestCapture: null }),
  apply(previous, event) {
    const record = pluginRecordOf(event)
    if (record?.type !== 'plugin:clinical-review/state') return previous
    const state = stateSchema.parse(record.data)
    if (state.ownerSessionId !== previous.ownerSessionId) return previous
    const accepted = [...state.history, ...(state.report === null ? [] : [state.report])]
    const added = accepted.filter(report => !previous.reports.some(retained => retained.report.reportId === report.reportId))
    const captured = state.snapshot !== null && state.operations.some(operation => operation.revision === state.revision
      && (operation.status === 'dispatched' || operation.status === 'refreshed'))
    const latestCapture = captured && previous.latestCapture?.revision !== state.revision
      ? { revision: state.revision, snapshot: state.snapshot } : previous.latestCapture
    if (added.length === 0 && latestCapture === previous.latestCapture) return previous
    return { ...previous, latestCapture, reports: [...previous.reports, ...added.map(report => ({ report,
      snapshot: state.snapshot?.caseRevision === report.caseRevision ? state.snapshot : null,
      generatedAt: state.report?.reportId === report.reportId ? new Date(record.time).toISOString() : null,
    }))] }
  },
}
