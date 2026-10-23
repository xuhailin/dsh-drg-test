/** Authenticated runtime API for EMR entry and asynchronous advisory review. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { parseLaunchClaim, EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { z } from 'zod'
import type { Config } from './config.ts'
import type { ClinicalReviewService } from './state.ts'
import { ClinicalReviewError } from './error.ts'
import { resultsRequestSchema, resultRequestSchema, rerunRequestSchema } from './result.ts'

const text = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const sessionRequest = z.strictObject({ sessionId: text })
const eventRequest = sessionRequest.extend({ eventId: text })
const reviewRequest = eventRequest.extend({ trigger: z.enum(['manual-review', 'discharge-order']) })

/** Parse one bounded authenticated clinical JSON request without accepting partial bodies.
 * @param request - HTTP request with application/json content.
 * @param maxBytes - Limit across the complete request body.
 * @returns Parsed JSON for the route's strict request schema.
 */
export async function readReviewBody(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ClinicalReviewError('invalid-request', 'Send application/json.')
  const reader = request.body?.getReader()
  if (reader === undefined) throw new ClinicalReviewError('invalid-request', 'Send a JSON request body.')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) { await reader.cancel(); throw new ClinicalReviewError('limit-exceeded', 'The complete review request exceeds its configured limit.') }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed
}

/** Mount exact routes behind Connection's owner authentication and Host/Origin checks.
 * @param ctx - Runtime connection scope.
 * @param review - Review state owner.
 * @param config - Request bounds.
 */
export function registerReviewBridge(ctx: Context, review: ClinicalReviewService, config: Config): void {
  const routes: Record<string, (value: unknown, signal: AbortSignal) => Promise<object>> = {
    launch: (value, signal) => review.launch(parseLaunchClaim(value), signal),
    review: (value, signal) => {
      const request = reviewRequest.parse(value)
      return review.trigger(SessionId(request.sessionId), request.eventId, request.trigger, signal)
    },
    refresh: (value, signal) => { const request = eventRequest.parse(value); return review.trigger(SessionId(request.sessionId), request.eventId, 'refresh', signal) },
    status: value => review.status(SessionId(sessionRequest.parse(value).sessionId)),
    results: (value, signal) => review.results(resultsRequestSchema.parse(value), signal),
    result: (value, signal) => review.result(resultRequestSchema.parse(value), signal),
    rerun: (value, signal) => review.rerun(rerunRequestSchema.parse(value), signal),
  }
  for (const [name, operation] of Object.entries(routes)) {
    ctx.connection.fetch.register({ path: `/api/clinical-review/${name}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const value = await operation(await readReviewBody(request, config.maxRequestBytes), request.signal)
          return Response.json(value, { status: name === 'review' || name === 'refresh' || name === 'rerun' ? 202 : 200, headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          const typed = error instanceof ClinicalReviewError || error instanceof EncounterReadError
          const code = typed ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid-request' : 'review-unavailable'
          const message = typed ? error.message : code === 'invalid-request' ? 'The review request contains invalid fields.' : 'The review is unavailable. EMR discharge is unaffected.'
          const status = code === 'forbidden' ? 403 : code === 'invalid-request' ? 400 : code === 'limit-exceeded' ? 413
            : code === 'result-not-found' || code === 'session-unavailable' || code === 'unbound-session' ? 404 : code === 'request-conflict' ? 409 : 503
          return Response.json({ error: { code, message }, dischargeBlocked: false }, { status, headers: { 'cache-control': 'no-store' } })
        }
      },
    })
  }
}
