import { once } from 'node:events'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerAccess } from '../src/reader.ts'
import { Config } from '../src/config.ts'

const contexts: Context[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
})
const claim = { eventId: 'opened', trigger: 'open' as const, sourceSystem: 'emr', hospitalCode: '1001', inpatId: '123' }
const binding = { schemaVersion: 1, bindingId: '11111111-1111-4111-8111-111111111111', actorId: 'actor-a', actorIssuer: 'https://issuer.example', actorSubject: 'doctor-a', sourceSystem: 'emr', hospitalCode: '1001', inpatId: '123' }

async function harness(response: (operation: string) => { status?: number; value: unknown }, maxResponseBytes = 65536) {
  const requests: { operation: string; token: string | string[] | undefined; body: unknown }[] = []
  const handle = async (request: IncomingMessage, reply: ServerResponse) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of request) {
      if (!(chunk instanceof Uint8Array)) throw new Error('unexpected fixture request chunk')
      chunks.push(chunk)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const operation = request.url ?? ''
    requests.push({ operation, token: request.headers['x-api-key'], body: value })
    const result = response(operation)
    reply.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
    reply.end(JSON.stringify(result.value))
  }
  const server = createServer((request, reply) => {
    void handle(request, reply).catch(() => { reply.destroy() })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing address')
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { TEST_CLINICAL_TOKEN: 'fixture-runtime-token' } }]))
  const config = Config({ brokerBaseUrl: `http://127.0.0.1:${address.port}/runtime/emr/`, runtimeTokenEnv: 'TEST_CLINICAL_TOKEN', ownerId: 'actor-a', cwd: '/tmp', maxResponseBytes })
  return { access: new BrokerAccess(ctx, config), requests, config }
}

describe('authenticated encounter HTTP reader', () => {
  it('exchanges claims for a one-use grant and keeps credentials out of configuration and the binding', async () => {
    const { access, requests, config } = await harness(operation => ({ value: operation.endsWith('launch') ? { grant: 'a'.repeat(64), expiresAt: '2026-10-22T00:00:00.000Z' } : binding }))
    expect(await access.authorize(claim, new AbortController().signal)).toEqual(binding)
    expect(requests.map(request => request.operation)).toEqual(['/runtime/emr/launch', '/runtime/emr/consume'])
    expect(requests.every(request => request.token === 'fixture-runtime-token')).toBe(true)
    expect(requests[1]?.body).toEqual({ grant: 'a'.repeat(64) })
    expect(JSON.stringify(config)).not.toContain('fixture-runtime-token')
  })

  it('rejects another actor and never exposes upstream error bodies', async () => {
    const wrong = await harness(operation => ({ value: operation.endsWith('launch') ? { grant: 'a'.repeat(64), expiresAt: '2026-10-22T00:00:00.000Z' } : { ...binding, actorId: 'actor-b' } }))
    await expect(wrong.access.authorize(claim, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' })
    const unavailable = await harness(() => ({ status: 500, value: { detail: 'sensitive database diagnostic' } }))
    await expect(unavailable.access.authorize(claim, new AbortController().signal)).rejects.toMatchObject({ code: 'source-unavailable' })
    await expect(unavailable.access.authorize(claim, new AbortController().signal)).rejects.not.toThrow('sensitive database diagnostic')
  })

  it('rejects oversized complete responses and modified source bytes', async () => {
    const large = await harness(() => ({ value: { content: '文'.repeat(100) } }), 50)
    await expect(large.access.authorize(claim, new AbortController().signal)).rejects.toMatchObject({ code: 'limit-exceeded' })
    const invalid = await harness(operation => ({ value: operation.endsWith('launch') ? { grant: 'a'.repeat(64), expiresAt: '2026-10-22T00:00:00.000Z' }
      : operation.endsWith('consume') ? binding : { schemaVersion: 1, bindingId: binding.bindingId, caseRevision: 'a'.repeat(64), providerRevision: 'v1',
        capturedAt: '2026-10-22T00:00:00.000Z', cutoff: '2026-10-22T00:00:00.000Z', sources: [{ sourceRef: 's', sourceId: 's', sourceRevision: 'v1', category: 'documents', state: 'signed', content: 'changed', contentDigest: createHash('sha256').update('original').digest('hex') }],
        coverage: ['encounter', 'diagnoses', 'orders', 'documents', 'labs', 'checks', 'operations', 'administration'].map(category => ({ category, status: 'unsupported' })) } }))
    const accepted = await invalid.access.authorize(claim, new AbortController().signal)
    await expect(invalid.access.capture(accepted, new AbortController().signal)).rejects.toMatchObject({ code: 'source-mismatch' })
  })
})
