/** Strict parsing for public viewer settings and reference-only addresses. */
import { z } from 'zod'
import type { ViewerConfig } from '../types.ts'
import { resultRequestSchema, resultsRequestSchema, type ResultRequest } from '@deepseek-ai/dsh-experimental-clinical-review/result'

/** Public deployment settings; credentials and clinical bodies are never accepted. */
export const viewerConfigSchema = z.object({
  allowedOrigins: z.array(z.string()), requestTimeoutMs: z.number().int().positive().max(2147483647),
  maxMessageBytes: z.number().int().positive(), maxPendingRequests: z.number().int().min(1).max(32),
  maxActionReceipts: z.number().int().positive(),
  directoryPageSize: z.number().int().min(1).max(1000),
}).strict() satisfies z.ZodType<ViewerConfig>

/** One explicitly selected saved report revision. */
export type ResultRef = ResultRequest
/** Validate caller-supplied selection references without granting authorization. */
export const resultSelectionSchema = resultsRequestSchema.extend({
  resultId: resultRequestSchema.shape.resultId.optional(), revision: z.number().int().positive().optional(),
}).strict().refine(value => (value.resultId === undefined) === (value.revision === undefined))
/** An encounter-bound result listing, optionally narrowed to one revision. */
export type ResultSelection = z.infer<typeof resultSelectionSchema>

/**
 * Encode one immutable selection for the registered Sidebar viewer.
 * @param ref - saved report identity.
 * @returns a reference-only resource address.
 */
export function resultAddress(ref: ResultRef): string {
  return `dsh-resource://clinical-result/${[ref.sessionId, ref.resultId, String(ref.revision)].map(encodeURIComponent).join('/')}`
}
/**
 * Parse a saved Sidebar address without interpreting patient identifiers.
 * @param address - untrusted persisted or caller-supplied address.
 * @returns a validated selection, or undefined for unsupported addresses.
 */
export function parseResultAddress(address: string): ResultRef | undefined {
  const match = /^dsh-resource:\/\/clinical-result\/([^?#]+)$/.exec(address)
  if (match === null) return undefined
  let parts: string[]
  const encoded = match[1]
  if (encoded === undefined) return undefined
  try { parts = encoded.split('/').map(decodeURIComponent) }
  catch (_invalidEncoding) { return undefined }
  const [sessionId, resultId, revision] = parts
  if (parts.length !== 3 || revision === undefined || !/^[1-9][0-9]*$/.test(revision)) return undefined
  const parsed = resultRequestSchema.safeParse({ sessionId, resultId, revision: Number(revision) })
  return parsed.success ? parsed.data : undefined
}
/**
 * Read a direct link containing references only; opening it performs no review.
 * @param search - browser query string.
 * @returns validated selection, or undefined when a link has no supported reference.
 */
export function selectionFromSearch(search: string): ResultSelection | undefined {
  const query = new URLSearchParams(search)
  const sessionId = query.get('sessionId')
  if (sessionId === null) return undefined
  const resultId = query.get('resultId'), revision = query.get('revision'), encounterRef = query.get('encounterRef')
  const parsed = resultSelectionSchema.safeParse({ sessionId, ...(resultId === null ? {} : { resultId }),
    ...(revision === null ? {} : { revision: /^[1-9][0-9]*$/.test(revision) ? Number(revision) : 0 }),
    ...(encounterRef === null ? {} : { encounterRef }),
  })
  return parsed.success ? parsed.data : undefined
}
