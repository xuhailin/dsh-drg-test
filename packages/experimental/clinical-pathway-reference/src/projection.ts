/** Replay private reference revisions without exposing them as implicit model input. */
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { definitionSchema, metadataSchema, scopeSchema, stateSchema } from './protocol.ts'
import { importSource } from './import.ts'
import type { ReferenceSourceIndex } from './types.ts'
/** Forked records retain their original owner; the service checks it before every read or write. */
export const referenceProjection = {
  key: 'clinicalPathwayReference', stateVersion: 1, stateSchema: stateSchema.nullable(), init: () => null,
  apply: (state, event) => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:clinical-pathway-reference/state' ? stateSchema.parse(record.data) : state
  },
  wire: { viewSchema: z.number().int().nonnegative(), view: state => state?.revisions.at(-1)?.revision ?? 0 },
} satisfies ProjectionDefinition<'clinicalPathwayReference'>

const sourceIndexSchema: z.ZodType<ReferenceSourceIndex> = z.strictObject({ calls: z.array(z.string()), sources: z.array(z.strictObject({
  eventSeq: z.number().int().nonnegative(), definition: definitionSchema, metadata: metadataSchema,
  definitionId: z.string(), readAt: z.string(), sourceSystem: z.string(), scope: scopeSchema,
})) })
/** Fold source results once during replay or append, retaining exact tool identity and Session event positions. */
export const sourceProjection: ProjectionDefinition<'clinicalPathwayReferenceSources'> = {
  key: 'clinicalPathwayReferenceSources', stateVersion: 1, stateSchema: sourceIndexSchema,
  init: () => ({ calls: [], sources: [] }),
  apply: (state, event) => {
    if (event.type === 'tool/call' && event.data.name === 'pathway_read') return { ...state, calls: [...state.calls, event.data.callId] }
    let content: readonly { type: string; text?: string }[] | undefined
    let calls = state.calls
    if (event.type === 'tool/result' && calls.includes(event.data.message.toolCallId)) {
      calls = calls.filter(id => id !== event.data.message.toolCallId)
      if (!event.data.message.isError) content = event.data.message.content
    }
    if (event.type === 'tool/ptc-dispatch' && event.data.name === 'pathway_read' && !event.data.isError) content = event.data.content
    if (content === undefined) return calls === state.calls ? state : { ...state, calls }
    const sources = [...state.sources]
    for (const block of content) {
      if (block.type !== 'text' || block.text === undefined) continue
      try { sources.push({ ...importSource(JSON.parse(block.text)), eventSeq: event.seq }) }
      catch (error) {
        // Candidate lists, failures and unsupported source structures remain logged but are not exact definition choices.
        if (!(error instanceof Error)) throw error
      }
    }
    return { calls, sources }
  },
}
