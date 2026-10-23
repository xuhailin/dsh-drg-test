/** Authenticated browser directory routes forward only validated selectors to the controlled broker. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { departmentDirectoryRequestSchema, patientDirectoryRequestSchema, EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { z } from 'zod'
import type { Config } from './config.ts'
import type { BrokerAccess } from './reader.ts'
import { ClinicalReviewError } from './error.ts'
import { readReviewBody } from './bridge.ts'

/** Register reversible directory routes behind Connection owner authentication and origin checks.
 * @param ctx - Runtime connection scope.
 * @param config - Complete request bounds.
 * @param access - Broker client carrying the private runtime credential.
 */
export function registerClinicalDirectory(ctx: Context, config: Config, access: Pick<BrokerAccess, 'departments' | 'patients'>): void {
  const routes: Record<string, (value: unknown, signal: AbortSignal) => Promise<object>> = {
    departments: (value, signal) => access.departments(departmentDirectoryRequestSchema.parse(value), signal),
    patients: (value, signal) => access.patients(patientDirectoryRequestSchema.parse(value), signal),
  }
  for (const [name, operation] of Object.entries(routes)) ctx.connection.fetch.register({
    path: `/api/clinical-review/${name}`, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const result = await operation(await readReviewBody(request, config.maxRequestBytes), request.signal)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        const typed = error instanceof ClinicalReviewError || error instanceof EncounterReadError
        const code = typed ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid-request' : 'source-unavailable'
        const message = typed ? error.message : code === 'invalid-request' ? 'The patient directory request contains invalid fields.' : 'The patient directory is unavailable. Check the clinical reader and reload.'
        const status = code === 'forbidden' ? 403 : code === 'invalid-request' ? 400 : code === 'limit-exceeded' ? 413 : 503
        return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } })
      }
    },
  })
}
