/** Real loopback HTTP responses exercise bounded evidence transport and cancellation ownership. */
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { PathwayAccess } from '../src/access.ts'
import { Config } from '../src/config.ts'
import type { ReadResult } from '../src/protocol.ts'

function evidence(): ReadResult {
  return { schemaVersion: 1, tool: 'case_read', sourceSystem: 'synthetic-source',
    scope: { hospitalCode: 'h1', departmentCodes: ['d1'], departmentBasis: 'current', admissionFrom: '2025-01-01T00:00:00Z',
      admissionTo: '2026-01-01T00:00:00Z', includeSharedDefinitions: false },
    readStartedAt: '2025-02-01T00:00:00Z', readCompletedAt: '2025-02-01T00:00:01Z', filters: { inpatId: '101', category: 'encounter' },
    collections: { encounter: [{ inpatId: '101', text: 'Synthetic evidence' }] }, measures: {}, nextOffset: null, truncated: false, coverage: [] }
}

interface FixtureOptions {
  config?: Partial<Config>
  credential?: () => Promise<ResolvedCredential | undefined>
  launchToken?: string | null
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void, options: FixtureOptions = {}) {
  const ctx = new Context()
  const requests: { method: string | undefined; url: string | undefined; token: string | string[] | undefined }[] = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, token: request.headers['x-api-key'] })
    request.resume()
    handler(request, response)
  })
  const resources: { access?: PathwayAccess } = {}
  onTestFinished(async () => {
    try { await ctx.fiber.dispose(); await resources.access?.dispose() } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })
  const token = options.launchToken === undefined ? 'synthetic-runtime-token' : options.launchToken
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: token === null ? {} : { HOSTED_RUNTIME_API_KEY: token } }]))
  if (options.credential !== undefined) {
    // This fixture replaces only the external provider capability consumed by PathwayAccess.
    ctx.provide('credentials', { resolve: options.credential } as never)
  }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Synthetic pathway server did not bind TCP')
  const config = Config({ mode: 'tools', brokerBaseUrl: `http://127.0.0.1:${address.port}/runtime/clinical-pathway`, ...options.config })
  const client = new PathwayAccess(ctx, config)
  resources.access = client
  ctx.effect(() => () => client.dispose(), 'synthetic pathway reader lifetime')
  return { ctx, access: client, config, requests }
}

const args = { inpatId: '101', category: 'encounter' }
const signal = () => new AbortController().signal

describe('pathway evidence HTTP client', () => {
  it.each([
    {},
    { brokerBaseUrl: 'file:///synthetic/pathway/' },
    { brokerBaseUrl: 'https://synthetic-user@synthetic.invalid/pathway/' },
    { brokerBaseUrl: 'https://:synthetic-password@synthetic.invalid/pathway/' },
    { brokerBaseUrl: 'https://synthetic.invalid/pathway/?credential=synthetic' },
    { brokerBaseUrl: 'https://synthetic.invalid/pathway/#synthetic' },
    { brokerBaseUrl: 'https://synthetic.invalid/pathway/', runtimeTokenEnv: 'invalid-name' },
  ])('rejects incomplete or credential-bearing routing before transport: %j', async (routing) => {
    const ctx = new Context()
    try { expect(() => new PathwayAccess(ctx, Config({ mode: 'tools', ...routing }))).toThrow('clinical-pathway-reader:') }
    finally { await ctx.fiber.dispose() }
  })

  it('accepts a configured HTTP prefix with its existing trailing slash', async () => {
    const ctx = new Context()
    try {
      const access = new PathwayAccess(ctx, Config({ mode: 'tools', brokerBaseUrl: 'https://synthetic.invalid/pathway/' }))
      await access.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('returns validated evidence and sends the server credential only as an HTTP header', async () => {
    const value = evidence()
    const world = await fixture((_request, response) => { response.end(JSON.stringify(value)) })
    expect(await world.access.read('case_read', args, signal())).toEqual(value)
    expect(world.requests).toEqual([{ method: 'POST', url: '/runtime/clinical-pathway/case_read', token: 'synthetic-runtime-token' }])
    expect(JSON.stringify(value)).not.toContain('synthetic-runtime-token')
  })

  it.each([{ status: 403, code: 'forbidden' }, { status: 404, code: 'not-found' }, { status: 400, code: 'invalid-request' },
    { status: 413, code: 'limit-exceeded' }, { status: 408, code: 'cancelled' }, { status: 503, code: 'source-unavailable' }])('preserves declared $status failures', async ({ status, code }) => {
    const world = await fixture((_request, response) => {
      response.writeHead(status)
      response.end(JSON.stringify({ error: { code, message: 'Synthetic access failure' } }))
    })
    await expect(world.access.read('case_read', args, signal())).rejects.toMatchObject({ code, message: 'Synthetic access failure' })
  })

  it('rejects oversized transport and model-visible results independently', async () => {
    const oversized = await fixture((_request, response) => { response.end('x'.repeat(2048)) }, { config: { maxResponseBytes: 512 } })
    const transportFailure = oversized.access.read('case_read', args, signal())
    await expect(transportFailure).rejects.toMatchObject({ code: 'limit-exceeded' })
    await expect(transportFailure).rejects.toThrow('complete pathway response')
    const value = evidence()
    value.collections.encounter = [{ text: '"'.repeat(200) }]
    const raw = JSON.stringify(value)
    const budget = Math.max(512, Buffer.byteLength(raw))
    expect(Buffer.byteLength(JSON.stringify([{ type: 'text', text: raw }]))).toBeGreaterThan(budget)
    const rendered = await fixture((_request, response) => { response.end(raw) }, { config: { maxResponseBytes: budget } })
    const renderedFailure = rendered.access.read('case_read', args, signal())
    await expect(renderedFailure).rejects.toMatchObject({ code: 'limit-exceeded' })
    await expect(renderedFailure).rejects.toThrow('model-visible result')
  })

  it.each(['not JSON', JSON.stringify({ error: 'untrusted upstream detail' }), JSON.stringify({ ...evidence(), tool: 'history_query' })])(
    'rejects invalid or mismatched successful responses', async (body) => {
      const world = await fixture((_request, response) => { response.end(body) })
      await expect(world.access.read('case_read', args, signal())).rejects.toMatchObject({ code: body.includes('history_query') ? 'source-mismatch' : 'source-unavailable' })
    },
  )

  it('does not accept arbitrary remote errors or follow redirects carrying a credential', async () => {
    const invalid = await fixture((_request, response) => { response.writeHead(500); response.end(JSON.stringify({ error: { code: 'database-secret', message: 'untrusted detail' } })) })
    await expect(invalid.access.read('case_read', args, signal())).rejects.toThrow('The pathway reader did not return an accepted result.')
    const redirect = await fixture((_request, response) => { response.writeHead(302, { location: '/redirected' }); response.end() })
    await expect(redirect.access.read('case_read', args, signal())).rejects.toMatchObject({ code: 'source-unavailable' })
    expect(redirect.requests).toHaveLength(1)
  })

  it.each([
    { status: 204, body: '' },
    { status: 500, body: JSON.stringify({ error: 'synthetic-unrecognized-upstream-error' }) },
  ])('rejects empty or undeclared HTTP $status responses', async ({ status, body }) => {
    const world = await fixture((_request, response) => { response.writeHead(status); response.end(body) })
    await expect(world.access.read('case_read', args, signal())).rejects.toMatchObject({ code: 'source-unavailable' })
  })

  it('aborts and drains an in-flight HTTP read when its plugin lifetime ends', async () => {
    const received = Promise.withResolvers<undefined>()
    const disconnected = Promise.withResolvers<undefined>()
    const world = await fixture((_request, response) => {
      response.once('close', () => { disconnected.resolve(undefined) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{')
      received.resolve(undefined)
    })
    let settled = false
    const outcome = world.access.read('case_read', args, signal()).catch((error: unknown) => error).finally(() => { settled = true })
    await received.promise
    await world.ctx.fiber.dispose()
    expect(settled).toBe(true)
    expect(await outcome).toMatchObject({ code: 'cancelled', message: 'The pathway reader was unloaded. Start a read from an active pathway analysis session.' })
    await disconnected.promise
    await expect(world.access.read('case_read', args, signal())).rejects.toMatchObject({ code: 'cancelled' })
    expect(world.requests).toHaveLength(1)
  })

  it('distinguishes caller cancellation from a response deadline', async () => {
    const received = Promise.withResolvers<undefined>()
    const world = await fixture((_request, response) => { response.writeHead(200); response.write('{'); received.resolve(undefined) })
    const cancelled = new AbortController()
    const outcome = world.access.read('case_read', args, cancelled.signal).catch((error: unknown) => error)
    await received.promise
    cancelled.abort()
    expect(await outcome).toMatchObject({ code: 'cancelled', message: 'Pathway read was cancelled.' })
    const deadline = await fixture((_request, response) => { response.writeHead(200); response.write('{') }, { config: { timeoutMs: 100 } })
    const deadlineFailure = deadline.access.read('case_read', args, signal())
    await expect(deadlineFailure).rejects.toMatchObject({ code: 'source-unavailable' })
    await expect(deadlineFailure).rejects.toThrow('time limit')
  })

  it('cancels a streaming HTTP response with a caller-provided reason', async () => {
    const received = Promise.withResolvers<undefined>()
    const world = await fixture((_request, response) => { response.writeHead(200); response.write('{'); received.resolve(undefined) })
    const cancelled = new AbortController()
    const outcome = world.access.read('case_read', args, cancelled.signal).catch((error: unknown) => error)
    await received.promise
    cancelled.abort('synthetic caller reason')
    expect(await outcome).toMatchObject({ code: 'cancelled', message: 'Pathway read was cancelled.' })
  })

  it('stops when credential resolution synchronously cancels the owning read', async () => {
    const cancelled = new AbortController()
    const world = await fixture((_request, response) => { response.end() }, { credential: () => {
      cancelled.abort('synthetic credential lookup cancellation')
      return Promise.resolve({ value: 'synthetic-provider-token', source: 'environment' })
    } })
    await expect(world.access.read('case_read', args, cancelled.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(world.requests).toEqual([])
  })

  it('retains a credential failure that settles alongside caller cancellation', async () => {
    const cancelled = new AbortController()
    const failure = new Error('synthetic credential provider failure')
    const world = await fixture((_request, response) => { response.end() }, { credential: () => {
      cancelled.abort('synthetic simultaneous cancellation')
      return Promise.reject(failure)
    } })
    await expect(world.access.read('case_read', args, cancelled.signal)).rejects.toMatchObject({ code: 'source-unavailable', cause: failure })
    expect(world.requests).toEqual([])
  })

  it('includes a blocked credential lookup in the deadline and ignores its late value', async () => {
    const entered = Promise.withResolvers<undefined>()
    const resolution = Promise.withResolvers<ResolvedCredential | undefined>()
    const providerSettled = Promise.withResolvers<undefined>()
    const world = await fixture((_request, response) => { response.end(JSON.stringify(evidence())) }, {
      config: { timeoutMs: 100 }, credential: () => {
        entered.resolve(undefined)
        return resolution.promise.finally(() => { providerSettled.resolve(undefined) })
      },
    })
    const outcome = world.access.read('case_read', args, signal()).catch((error: unknown) => error)
    await entered.promise
    expect(await outcome).toMatchObject({ code: 'source-unavailable',
      message: 'The pathway read exceeded its configured time limit. Retry with a narrower query or ask the operator to check the source.' })
    resolution.resolve({ value: 'late-synthetic-token', source: 'environment' })
    await providerSettled.promise
    expect(world.requests).toEqual([])
  })

  it('drains credential waits on disposal and observes a late provider rejection without sending HTTP', async () => {
    const entered = Promise.withResolvers<undefined>()
    const resolution = Promise.withResolvers<ResolvedCredential | undefined>()
    const providerSettled = Promise.withResolvers<undefined>()
    const world = await fixture((_request, response) => { response.end(JSON.stringify(evidence())) }, {
      credential: () => { entered.resolve(undefined); return resolution.promise.finally(() => { providerSettled.resolve(undefined) }) },
    })
    const outcome = world.access.read('case_read', args, signal()).catch((error: unknown) => error)
    await entered.promise
    await world.access.dispose()
    expect(await outcome).toMatchObject({ code: 'cancelled' })
    resolution.reject(new Error('late synthetic provider failure'))
    await providerSettled.promise
    expect(world.requests).toEqual([])
  })

  it('preserves credential failures and rejects missing credentials or pre-cancelled reads without HTTP', async () => {
    const providerFailure = new Error('synthetic credential failure')
    const failure = await fixture((_request, response) => { response.end() }, { credential: () => Promise.reject(providerFailure) })
    await expect(failure.access.read('case_read', args, signal())).rejects.toMatchObject({ code: 'source-unavailable', cause: providerFailure })
    expect(failure.requests).toEqual([])
    const missing = await fixture((_request, response) => { response.end() }, { launchToken: null })
    await expect(missing.access.read('case_read', args, signal())).rejects.toMatchObject({ code: 'forbidden' })
    const resolve = vi.fn(async () => ({ value: 'synthetic-provider-token', source: 'environment' as const }))
    const cancelled = await fixture((_request, response) => { response.end() }, { credential: resolve })
    const abort = new AbortController(); abort.abort('synthetic caller cancellation')
    await expect(cancelled.access.read('case_read', args, abort.signal)).rejects.toMatchObject({ code: 'cancelled' })
    const structuredAbort = new AbortController()
    structuredAbort.abort(new EncounterReadError('forbidden', 'Synthetic cancellation reason'))
    await expect(cancelled.access.read('case_read', args, structuredAbort.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(resolve).not.toHaveBeenCalled()
    expect(cancelled.requests).toEqual([])
  })
})
