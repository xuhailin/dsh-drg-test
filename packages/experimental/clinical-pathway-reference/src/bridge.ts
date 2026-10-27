/** Private Connection routes share the same validated Session state owner as model tools. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import { ReferenceConflict } from './change.ts'
import { ReferenceError } from './error.ts'
import { commitRequestSchema, createRequestSchema, readRequestSchema, undoRequestSchema } from './protocol.ts'
import type { ReferenceService } from './state.ts'

async function body(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ReferenceError('invalid-request', 'Send application/json.')
  const reader = request.body?.getReader()
  if (reader === undefined) throw new ReferenceError('invalid-request', 'Send a complete JSON request.')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maxBytes) { await reader.cancel(); throw new ReferenceError('limit-exceeded', 'The complete reference request exceeds its configured limit.') }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
/**
 * Register private reference routes on the runtime Connection.
 * @param ctx - Authenticated runtime Connection.
 * @param service - Reference state owner.
 */
export function registerBridge(ctx: Context, service: ReferenceService): void {
  const headers = { 'cache-control': 'no-store' }
  ctx.connection.fetch.register({ path: '/api/pathway-reference/config', methods: ['GET'], requestBody: 'buffered', fetch: () => Promise.resolve(Response.json(service.config, { headers })) })
  const routes: Record<string, (value: unknown) => Promise<object>> = {
    read: value => service.read(readRequestSchema.parse(value).sessionId),
    create: value => service.create(createRequestSchema.parse(value)),
    commit: value => service.commit(commitRequestSchema.parse(value)),
    undo: value => service.undo(undoRequestSchema.parse(value)),
  }
  for (const [name, execute] of Object.entries(routes)) ctx.connection.fetch.register({ path: `/api/pathway-reference/${name}`, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try { return Response.json(await execute(await body(request, service.config.maxRequestBytes)), { headers }) }
      catch (error) {
        const code = error instanceof ReferenceError ? error.code : error instanceof ReferenceConflict ? 'conflict'
          : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid-request' : 'unavailable'
        const message = error instanceof ReferenceError || error instanceof ReferenceConflict ? error.message
          : code === 'invalid-request' ? 'The reference request contains invalid fields.' : 'The reference is unavailable. Retain the last confirmed preview and retry after reconnecting.'
        return Response.json({ error: { code, message } }, { headers, status: code === 'forbidden' ? 403 : code === 'not-found' ? 404
          : code === 'invalid-request' ? 400 : code === 'conflict' ? 409 : code === 'limit-exceeded' ? 413 : 503 })
      }
    },
  })
}
