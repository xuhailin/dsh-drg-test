/** Encounter-scoped, immutable clinical evidence exchanged by controlled readers. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Server-created encounter binding identity. */
export type EncounterBindingId = Branded<'EncounterBindingId'>
/** Content-derived revision; repeated captures of unchanged evidence retain this value. */
export type CaseRevision = Branded<'ClinicalCaseRevision'>
/** Snapshot-local source reference, never a patient selector. */
export type EvidenceSourceRef = Branded<'ClinicalEvidenceSourceRef'>
/** SHA-256 of exact UTF-8 source content. */
export type EvidenceDigest = Branded<'ClinicalEvidenceDigest'>
/** One-use launch capability. */
export type LaunchGrant = Branded<'ClinicalLaunchGrant'>

/** Identity supplied by authenticated runtime transport, never by model arguments. */
export interface ClinicalActor { readonly id: string; readonly issuer: string; readonly subject: string }
/** Browser claims require server authorization before producing a binding. */
export interface LaunchClaim {
  readonly eventId: string
  readonly trigger: 'open' | 'manual-review' | 'discharge-order'
  readonly sourceSystem: string
  readonly hospitalCode: string
  readonly inpatId: string
  readonly inpatCode?: string | undefined
  readonly sourceVisitId?: string | undefined
  readonly documentId?: string | undefined
  readonly documentRevision?: string | undefined
}
/** The actor and encounter accepted by the controlled reader. */
export interface EncounterBinding {
  readonly schemaVersion: 1
  readonly bindingId: EncounterBindingId
  readonly actorId: string
  readonly actorIssuer: string
  readonly actorSubject: string
  readonly sourceSystem: string
  readonly hospitalCode: string
  readonly inpatId: string
  readonly inpatCode?: string | undefined
  readonly sourceVisitId?: string | undefined
}
/** Coverage is explicit even when a provider does not support a source. */
export type EvidenceCategory = 'encounter' | 'diagnoses' | 'orders' | 'documents' | 'labs' | 'checks' | 'operations' | 'administration'
/** Original content and source metadata; state retains source-system meaning. */
export interface EvidenceSource {
  readonly sourceRef: EvidenceSourceRef
  readonly category: EvidenceCategory
  readonly sourceId: string
  readonly sourceRevision: string
  readonly state: string
  readonly occurredAt?: string | undefined
  readonly availableAt?: string | undefined
  readonly content: string
  readonly contentDigest: EvidenceDigest
}
/** Empty means the supported query returned no rows, not clinical absence. */
export interface EvidenceCoverage {
  readonly category: EvidenceCategory
  readonly status: 'complete' | 'empty' | 'unsupported' | 'unread'
  readonly detail?: string | undefined
}
/** Immutable captured evidence; revisions include source states and all coverage. */
export interface EncounterSnapshot {
  readonly schemaVersion: 1
  readonly bindingId: EncounterBindingId
  readonly caseRevision: CaseRevision
  readonly providerRevision: string
  readonly capturedAt: string
  readonly cutoff: string
  readonly sources: readonly EvidenceSource[]
  readonly coverage: readonly EvidenceCoverage[]
}
/** Short-lived grant response; no clinical content is included. */
export interface LaunchGrantResult { readonly grant: LaunchGrant; readonly expiresAt: string }
/** Typed expected failures, safe to expose without upstream diagnostics. */
export type EncounterErrorCode = 'invalid-request' | 'forbidden' | 'expired-grant' | 'invalid-binding' | 'not-found' | 'source-mismatch' | 'source-unavailable' | 'source-incomplete' | 'limit-exceeded' | 'cancelled'
