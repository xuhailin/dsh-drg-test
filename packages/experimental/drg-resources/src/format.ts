/** Strict validation for operator inputs and persisted archive metadata. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PackManifest, ResourceCatalog, ResourceDigest, ResourcePackId } from './types.ts'

/** Stable failure codes let operators distinguish invalid data from committed publication. */
export type ResourceErrorCode = 'invalid-input' | 'invalid-resource' | 'busy' | 'exists' | 'unavailable' | 'publication-incomplete' | 'io'

/** Archive failures retain the operation cause and any inspectable candidate directory. */
export class DrgResourceError extends Error {
  override readonly name = 'DrgResourceError'
  /**
   * Create an operation failure; stagePath is absent when no candidate was created.
   * @param code - stable handling category.
   * @param message - operator diagnostic and safe next action.
   * @param options - optional cause and retained candidate path.
   */
  constructor(readonly code: ResourceErrorCode, message: string, readonly options: { cause?: unknown; stagePath?: string } = {}) {
    super(message, options)
  }
}

const packIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/).refine(value => !value.includes('..'))
  .transform(value => brandString<ResourcePackId>(value))
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<ResourceDigest>(value))
const shortText = z.string().trim().min(1).max(160).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const sourceUrlSchema = z.url().max(2048).refine((value) => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
})
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1), profile: z.literal('source-only'), packId: packIdSchema,
  edition: shortText, derivedRevision: shortText, publishedAt: z.iso.datetime(),
  source: z.strictObject({ path: z.literal('sources/national.pdf'), url: sourceUrlSchema, sha256: digestSchema, bytes: z.number().int().positive().max(128 * 1024 * 1024) }),
  database: z.strictObject({ path: z.literal('reference.sqlite'), sha256: digestSchema, bytes: z.number().int().positive().max(1024 * 1024), schemaVersion: z.literal(1) }),
  readiness: z.strictObject({ groupingReady: z.literal(false), dictionary: z.literal('not-provided'), engine: z.literal('not-implemented'), rules: z.literal('not-extracted-or-reviewed') }),
})
const catalogSchema = z.strictObject({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  referenceDefault: packIdSchema.nullable(),
  packs: z.array(z.strictObject({ packId: packIdSchema, manifestSha256: digestSchema, availability: z.enum(['available', 'withdrawn']) })).max(1000),
}).superRefine((value, ctx) => {
  if (new Set(value.packs.map(pack => pack.packId)).size !== value.packs.length) ctx.addIssue({ code: 'custom', message: 'Duplicate pack IDs' })
  if (value.referenceDefault !== null && !value.packs.some(pack => pack.packId === value.referenceDefault && pack.availability === 'available')) {
    ctx.addIssue({ code: 'custom', message: 'Reference default is missing or withdrawn' })
  }
})

/**
 * Validate a pack identifier used in filesystem paths.
 * @param value - external identifier.
 * @returns normalized admitted identifier; throws invalid-input otherwise.
 */
export function resourcePackId(value: string): ResourcePackId {
  const result = packIdSchema.safeParse(value)
  if (!result.success) throw new DrgResourceError('invalid-input', 'Use a lowercase pack ID without traversal or separators.')
  return result.data
}

/**
 * Parse a persisted manifest without accepting executable grouping readiness.
 * @param value - JSON-decoded file content.
 * @returns validated metadata.
 */
export function parseManifest(value: unknown): PackManifest {
  const result = manifestSchema.safeParse(value)
  if (!result.success) throw new DrgResourceError('invalid-resource', 'Invalid source-only manifest; inspect the retained archive.', { cause: result.error })
  return result.data
}

/**
 * Parse mutable publication metadata and validate its default selection.
 * @param value - JSON-decoded catalog.
 * @returns validated catalog.
 */
export function parseCatalog(value: unknown): ResourceCatalog {
  const result = catalogSchema.safeParse(value)
  if (!result.success) throw new DrgResourceError('invalid-resource', 'Invalid resource catalog; restore a verified catalog backup.', { cause: result.error })
  return result.data
}

/**
 * Validate publication metadata before any staging write.
 * @param value - edition, revision, URL, and expected digest from the operator.
 * @returns validated text fields and digest.
 */
export function sourceMetadata(value: { edition: string; derivedRevision: string; sourceUrl: string; expectedSha256: string }): {
  edition: string
  derivedRevision: string
  sourceUrl: string
  expectedSha256: ResourceDigest
} {
  const result = z.strictObject({
    edition: shortText, derivedRevision: shortText, sourceUrl: sourceUrlSchema, expectedSha256: digestSchema,
  }).safeParse(value)
  if (!result.success) throw new DrgResourceError('invalid-input', 'Supply an edition, revision, exact HTTP source URL, and lowercase SHA-256.', { cause: result.error })
  return result.data
}
