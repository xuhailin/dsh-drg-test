/** Private pathway reference transport; clinical data uses the EMR-owned definition. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DefinitionDocument } from './emr/definition.generated.d.ts'
/** Frozen permitted analysis context; it grants no source read access. */
export interface ReferenceScope {
  /** Exact reader source identity allowed for this reference owner. */
  sourceSystem: string
  /** Hospital containing the source definitions and historical cohort. */
  hospitalCode: string
  /** Authorized current-department codes, retained with the task. */
  departmentCodes: string[]
  /** Department attribution uses current departments. */
  departmentBasis: 'current'
  /** Inclusive admission-window start as an offset-aware ISO timestamp. */
  admissionFrom: string
  /** Exclusive admission-window end as an offset-aware ISO timestamp. */
  admissionTo: string
}
/** Evidence gaps remain separate from the clinical definition. */
export interface ReferenceMetadata {
  coverage: string[]
  questions: { localId: string; field: string; message: string }[]
  evidence: { localId: string; sourceRef: string; observedAt: string; kind: 'source' | 'history' | 'opinion' | 'inference' }[]
}
/** One fully committed reference revision; the hospital is never changed. */
export interface ReferenceRevision {
  revision: number
  requestId: string
  requestDigest: string
  createdAt: string
  definition: DefinitionDocument
  metadata: ReferenceMetadata
  /** Object or object#field references; escape percent as %25 and identity/field delimiters as %23. */
  locks: string[]
  changedLocalIds: string[]
  undoes: number | null
}
/** Saved task state folds from ordinary plugin records in its private Session. */
export interface ReferenceState {
  schemaVersion: 1
  ownerSessionId: SessionId
  mode: 'new' | 'revision'
  title: string
  scope: ReferenceScope
  baseline: DefinitionDocument | null
  source: { eventSeq: number; definitionId: string; sourceSystem: string; readAt: string } | null
  revisions: ReferenceRevision[]
}
/** A logged exact definition can be selected without another source read. */
export interface ReferenceSource {
  eventSeq: number
  definitionId: string
  label: string
  readAt: string
  coverage: string[]
}
/** Read response always states whether a task has already been created. */
export interface ReferenceView { state: ReferenceState | null; sources: ReferenceSource[] }
/** Host-only source index folded from the original tool events; never a separate persisted clinical authority. */
export interface ReferenceSourceIndex {
  calls: string[]
  sources: {
    eventSeq: number
    definition: DefinitionDocument
    metadata: ReferenceMetadata
    definitionId: string
    readAt: string
    sourceSystem: string
    scope: ReferenceScope
  }[]
}
/** Public, credential-free bounds and permitted analysis scope. */
export interface ReferenceConfig {
  /** Frozen analysis scope; gateway policy independently authorizes source reads. */
  scope: ReferenceScope
  /** Maximum UTF-8 bytes in one complete browser or tool mutation request. */
  maxRequestBytes: number
  /** Maximum UTF-8 bytes in the complete retained task history. */
  maxStateBytes: number
  /** Maximum saved revisions before further changes are rejected. */
  maxRevisions: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Complete reference task and its revisions; no business-system writes. */
    'plugin:clinical-pathway-reference/state': ReferenceState
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { clinicalPathwayReference: ReferenceState | null }
  interface SessionProjectionStateMap { clinicalPathwayReferenceSources: ReferenceSourceIndex }
  interface SessionProjectionMap {
    /** Latest observed reference revision; readers wait for the durability checkpoint before displaying content. */
    clinicalPathwayReference: number
  }
}
