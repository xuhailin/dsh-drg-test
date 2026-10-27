/** Shared parsing for private reference HTTP, tool arguments and Session replay. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { readDefinition } from './emr/definition-reader.ts'
import type { DefinitionDocument } from './emr/definition.generated.d.ts'
import type { ReferenceConfig, ReferenceMetadata, ReferenceScope, ReferenceState, ReferenceView } from './types.ts'

const text = z.string().min(1).max(256)
const lockText = z.string().min(1).max(1024)
/** Validate clinical content with the exact EMR-owned reader, without defaults or coercion. */
export const definitionSchema: z.ZodType<DefinitionDocument> = z.unknown().transform((value, ctx) => {
  try { return readDefinition(value) } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid EMR reference definition.' })
    return z.NEVER
  }
})
/** Frozen analysis scope never grants access to source data. */
export const scopeSchema: z.ZodType<ReferenceScope> = z.strictObject({ sourceSystem: text, hospitalCode: text,
  departmentCodes: z.array(text).min(1).max(100), departmentBasis: z.literal('current'),
  admissionFrom: z.iso.datetime({ offset: true }), admissionTo: z.iso.datetime({ offset: true }),
}).refine(value => Date.parse(value.admissionFrom) < Date.parse(value.admissionTo), 'Choose a nonempty analysis window.')
/** Sources, unknown parameters and unresolved identities are retained outside clinical data. */
export const metadataSchema: z.ZodType<ReferenceMetadata> = z.strictObject({ coverage: z.array(z.string().max(4000)).max(500),
  questions: z.array(z.strictObject({ localId: text, field: z.string().max(256), message: z.string().min(1).max(4000) })).max(1000),
  evidence: z.array(z.strictObject({ localId: text, sourceRef: text, observedAt: z.iso.datetime({ offset: true }),
    kind: z.enum(['source', 'history', 'opinion', 'inference']) })).max(1000),
})
const sourceSchema = z.strictObject({ eventSeq: z.number().int().nonnegative(), definitionId: text,
  sourceSystem: text, readAt: z.iso.datetime({ offset: true }),
})
/** Complete state validation also runs on restored and forked records. */
export const stateSchema: z.ZodType<ReferenceState> = z.strictObject({
  schemaVersion: z.literal(1), ownerSessionId: text.transform(SessionId),
  mode: z.enum(['new', 'revision']), title: z.string().min(1).max(200), scope: scopeSchema,
  baseline: definitionSchema.nullable(), source: sourceSchema.nullable(),
  revisions: z.array(z.strictObject({ revision: z.number().int().positive(), requestId: text,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime({ offset: true }), definition: definitionSchema, metadata: metadataSchema,
    locks: z.array(lockText).max(1000), changedLocalIds: z.array(text), undoes: z.number().int().positive().nullable(),
  })).min(1),
}).superRefine((state, ctx) => {
  const requests = new Set<string>()
  for (const [index, revision] of state.revisions.entries()) {
    if (revision.revision !== index + 1 || requests.has(revision.requestId)
      || (revision.undoes !== null && (revision.undoes <= 1 || revision.undoes >= revision.revision))) {
      ctx.addIssue({ code: 'custom', path: ['revisions', index], message: 'Reference revision history is inconsistent.' })
    }
    requests.add(revision.requestId)
    if (revision.definition.clinicalPathway.localId !== state.revisions[0]?.definition.clinicalPathway.localId) {
      ctx.addIssue({ code: 'custom', path: ['revisions', index], message: 'The reference pathway identity must remain stable.' })
    }
  }
  if ((state.mode === 'new') !== (state.baseline === null && state.source === null)
    || (state.mode === 'revision' && (state.baseline === null || state.source === null))) {
    ctx.addIssue({ code: 'custom', message: 'Reference mode and source baseline are inconsistent.' })
  }
})
/** Credential-free settings consumed by the preset-local preview. */
export const configSchema: z.ZodType<ReferenceConfig> = z.strictObject({ scope: scopeSchema,
  maxRequestBytes: z.number().int().positive(), maxStateBytes: z.number().int().positive(), maxRevisions: z.number().int().positive(),
})
/** Authenticated read responses include exact logged definition choices. */
export const viewSchema: z.ZodType<ReferenceView> = z.strictObject({ state: stateSchema.nullable(), sources: z.array(z.strictObject({
  eventSeq: z.number().int().nonnegative(), definitionId: text, label: z.string(),
  readAt: z.iso.datetime({ offset: true }), coverage: z.array(z.string()),
})) })
/** Identify the active private Session without accepting a filesystem location. */
export const readRequestSchema = z.strictObject({ sessionId: text.transform(SessionId) })
/** Create one task from a blank definition or a previously logged exact read. */
export const createRequestSchema = readRequestSchema.extend({ requestId: text, mode: z.enum(['new', 'revision']), title: z.string().min(1).max(200),
  scope: scopeSchema, sourceEventSeq: z.number().int().nonnegative().optional(),
})
/** Commit a candidate against its exact base; this never writes to the hospital. */
export const commitRequestSchema = readRequestSchema.extend({ requestId: text, baseRevision: z.number().int().positive(),
  definition: definitionSchema, metadata: metadataSchema.optional(), locks: z.array(lockText).max(1000).optional(),
})
/** Undo one isolated revision while retaining independently changed objects. */
export const undoRequestSchema = readRequestSchema.extend({ requestId: text,
  baseRevision: z.number().int().positive(), revision: z.number().int().positive(),
})
