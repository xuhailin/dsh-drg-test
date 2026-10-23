/** Strict JSON validation shared by broker and runtime consumers. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CaseRevision, ClinicalActor, EncounterBinding, EncounterBindingId, EncounterSnapshot, EvidenceDigest, EvidenceSourceRef, LaunchClaim, LaunchGrant, LaunchGrantResult } from './types.ts'

const text = z.string().min(1).max(512).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const identifier = z.string().regex(/^[1-9][0-9]{0,18}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
/** Accepted source categories; every snapshot reports each once. */
export const evidenceCategories = ['encounter', 'diagnoses', 'orders', 'documents', 'labs', 'checks', 'operations', 'administration'] as const
/** Authenticated transport identity parser. */
export const actorSchema = z.strictObject({ id: text, issuer: text, subject: text })
/** Launch claims contain no credentials or actor override. */
export const launchClaimSchema = z.strictObject({
  eventId: text, trigger: z.enum(['open', 'manual-review', 'discharge-order']), sourceSystem: text,
  hospitalCode: text, inpatId: identifier, inpatCode: text.optional(), sourceVisitId: text.optional(),
  documentId: identifier.optional(), documentRevision: text.optional(),
})
/** Immutable binding parser; authorization remains the reader's responsibility. */
export const bindingSchema = z.strictObject({
  schemaVersion: z.literal(1), bindingId: z.uuid().transform(value => brandString<EncounterBindingId>(value)),
  actorId: text, actorIssuer: text, actorSubject: text,
  sourceSystem: text, hospitalCode: text, inpatId: identifier, inpatCode: text.optional(), sourceVisitId: text.optional(),
})
/** Exact evidence metadata and body returned by a provider. */
export const sourceSchema = z.strictObject({
  sourceRef: text.transform(value => brandString<EvidenceSourceRef>(value)), category: z.enum(evidenceCategories),
  sourceId: text, sourceRevision: text, state: text, occurredAt: text.optional(), availableAt: text.optional(),
  content: z.string(), contentDigest: hash.transform(value => brandString<EvidenceDigest>(value)),
})
/** Immutable snapshot parser with complete, unique coverage and source references. */
export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), bindingId: bindingSchema.shape.bindingId,
  caseRevision: hash.transform(value => brandString<CaseRevision>(value)), providerRevision: text,
  capturedAt: z.iso.datetime(), cutoff: z.iso.datetime(), sources: z.array(sourceSchema),
  coverage: z.array(z.strictObject({ category: z.enum(evidenceCategories), status: z.enum(['complete', 'empty', 'unsupported', 'unread']), detail: text.optional() })),
}).superRefine((value, ctx) => {
  if (new Set(value.sources.map(source => source.sourceRef)).size !== value.sources.length) ctx.addIssue({ code: 'custom', message: 'Duplicate source reference' })
  const categories = new Set(value.coverage.map(item => item.category))
  if (value.coverage.length !== evidenceCategories.length || categories.size !== evidenceCategories.length) ctx.addIssue({ code: 'custom', message: 'Coverage must list every category exactly once' })
})
/** One-use grant wire parser. */
export const grantResultSchema = z.strictObject({
  grant: z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<LaunchGrant>(value)), expiresAt: z.iso.datetime(),
})
/**
 * Parse a transport identity.
 * @param value - Wire input.
 * @returns Validated actor.
 */
export function parseActor(value: unknown): ClinicalActor { return actorSchema.parse(value) }
/**
 * Parse untrusted launch claims.
 * @param value - Wire input.
 * @returns Validated claims.
 */
export function parseLaunchClaim(value: unknown): LaunchClaim { return launchClaimSchema.parse(value) }
/**
 * Parse a binding without granting access.
 * @param value - Wire input.
 * @returns Validated binding.
 */
export function parseBinding(value: unknown): EncounterBinding { return bindingSchema.parse(value) }
/**
 * Parse an immutable evidence response.
 * @param value - Wire input.
 * @returns Validated snapshot.
 */
export function parseSnapshot(value: unknown): EncounterSnapshot { return snapshotSchema.parse(value) }
/**
 * Parse a launch grant response.
 * @param value - Wire input.
 * @returns Validated grant.
 */
export function parseLaunchGrantResult(value: unknown): LaunchGrantResult { return grantResultSchema.parse(value) }
