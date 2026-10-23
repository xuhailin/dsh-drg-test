/** Browser wire validation accepts encounter identifiers, never clinical text. */
import { z } from 'zod'
import { launchClaimSchema, type LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter/wire'
import type { EntryConfig } from '../types.ts'

const identifier = z.string().min(1).max(512)
const message = z.object({ type: z.literal('dsh.emr.launch'), value: launchClaimSchema }).strict()

/** Public deployment settings served by the authenticated Host. */
export const entryConfig = z.object({
  allowedOrigins: z.array(z.string()), defaultSourceSystem: identifier, defaultHospitalCode: identifier,
  requestTimeoutMs: z.number().int().positive().max(2147483647), maxPendingRequests: z.number().int().min(1).max(32),
  maxMessageBytes: z.number().int().positive(),
}) satisfies z.ZodType<EntryConfig>

/** Minimal metadata receipt; extra server fields never enter UI state or replies. */
export const receipt = z.object({
  sessionId: identifier, revision: z.number().int().nonnegative(),
  status: z.enum(['bound', 'accepted', 'duplicate']), dischargeBlocked: z.literal(false),
})

/** Progress-only response; clinical content and unrelated fields are discarded. */
export const reviewStatus = z.object({
  sessionId: identifier, revision: z.number().int().nonnegative(),
  status: z.enum(['bound', 'collecting', 'reviewing', 'reviewed', 'stale', 'failed', 'cancelled']),
  reportAvailable: z.boolean(), durability: z.enum(['confirmed', 'unknown']), dischargeBlocked: z.literal(false),
  operations: z.array(z.object({
    revision: z.number().int().nonnegative(),
    status: z.enum(['accepted', 'dispatched', 'refreshed', 'failed', 'cancelled']),
    errorCode: z.string().optional(),
  })),
})

/** Only the stable error code is used; server diagnostic text is never displayed. */
export const reviewFailure = z.object({ error: z.object({ code: z.string() }) })

/**
 * Validate one explicit-origin message from an already identified parent window.
 * @param data - untrusted postMessage data.
 * @param maxBytes - complete message byte limit.
 * @returns identifier-only claim, or undefined for a foreign or malformed message.
 */
export function parseLaunchMessage(data: unknown, maxBytes: number): LaunchClaim | undefined {
  const parsed = message.safeParse(data)
  if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > maxBytes) return undefined
  return parsed.data.value
}
