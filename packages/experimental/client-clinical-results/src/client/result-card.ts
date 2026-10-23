/** Exact accepted-report cards projected incrementally from saved plugin records. */
import { z } from 'zod'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { resultIdForSession } from '@deepseek-ai/dsh-experimental-clinical-review/result'
import { resultSelectionSchema, type ResultRef } from './protocol.ts'

const report = z.object({ reportId: z.string().min(1), findings: z.array(z.unknown()) })
const record = z.object({ schemaVersion: z.literal(1), ownerSessionId: z.string().min(1),
  binding: z.object({ bindingId: z.string().min(1), sourceSystem: z.string(), hospitalCode: z.string(),
    inpatId: z.string(), inpatCode: z.string().optional() }),
  report: report.nullable(), history: z.array(report),
  snapshot: z.object({ coverage: z.array(z.object({ status: z.string() })) }).nullable(),
})
/** One immutable report accepted during a Turn; no evidence bodies are copied into the card. */
export interface ResultCardData {
  readonly ref: ResultRef
  readonly reportId: string
  readonly encounterLabel: string
  readonly generatedAt: string | null
  readonly findingCount: number
  readonly coverageGaps: number | null
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Saved clinical report identity; the card opens its immutable revision. */
    'clinical-result': ResultCardData
  }
}

/**
 * Recognize saved report records without parsing assistant Markdown.
 * @param event - durable event or unrelated Conversation input.
 * @returns accepted report metadata, or undefined while no report has been accepted.
 */
export function cardFromRecord(
  event: { readonly type: string; readonly data: unknown; readonly time: number },
): ResultCardData | undefined {
  if (event.type !== 'plugin:clinical-review/state') return undefined
  const parsed = record.safeParse(event.data)
  if (!parsed.success || parsed.data.report === null) return undefined
  const state = parsed.data, accepted = state.report
  if (accepted === null) return undefined
  const ids = [...new Set([...state.history.map(item => item.reportId), accepted.reportId])]
  const ref = resultSelectionSchema.parse({ sessionId: state.ownerSessionId, resultId: resultIdForSession(state.ownerSessionId),
    revision: ids.indexOf(accepted.reportId) + 1 }) as ResultRef
  return { ref, reportId: accepted.reportId, encounterLabel: `${state.binding.sourceSystem} / ${state.binding.hospitalCode} / ${state.binding.inpatCode ?? state.binding.inpatId}`,
    generatedAt: new Date(event.time).toISOString(), findingCount: accepted.findings.length,
    coverageGaps: state.snapshot === null ? null : state.snapshot.coverage.filter(item => item.status === 'unread' || item.status === 'unsupported').length }
}

/** One hidden Chat node per immutable report; updates retain the original acceptance position and metadata. */
export const resultCardDefinition: ConversationNodeDefinition<ResultCardData> = {
  kind: 'clinical-result', target: 'chat',
  match: (event) => { const card = cardFromRecord(event); return card === undefined ? null : { id: card.reportId, role: 'start' } },
  start: (_context, match) => {
    const card = cardFromRecord(match.event)
    if (card === undefined) throw new Error('clinical-result requires an accepted report')
    return card
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.start === undefined || context.state === undefined) return null
    return { key: context.key, kind: 'clinical-result', id: context.id, target: 'chat', anchorSeq: context.start.event.seq,
      location: context.start.location, visibility: 'hidden', data: context.state } satisfies ChatNode<'clinical-result'>
  },
}
