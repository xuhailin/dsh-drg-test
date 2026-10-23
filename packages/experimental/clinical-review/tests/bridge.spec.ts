import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { ClinicalReviewService } from '../src/state.ts'
import { ClinicalReviewError } from '../src/error.ts'
import { registerReviewBridge } from '../src/bridge.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function setup(maxRequestBytes = 65536) {
  const ctx = new Context()
  contexts.push(ctx)
  const routes = new Map<string, ConnectionFetchRoute>()
  ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
    routes.set(route.path, route)
    return ctx.effect(() => async () => { routes.delete(route.path) })
  } } })
  const config = Config({ brokerBaseUrl: 'https://gateway.example/runtime/emr/', runtimeTokenEnv: 'TEST_TOKEN', ownerId: 'owner', cwd: '/tmp', maxRequestBytes })
  const review = new ClinicalReviewService(ctx, config, { authorize: () => Promise.reject(new Error('unused launch authority')) }, () => {})
  registerReviewBridge(ctx, review, config)
  const request = async (path: string, body: unknown) => {
    const route = routes.get(`/api/clinical-review/${path}`)
    if (route === undefined) throw new Error('missing route')
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('buffered')
    return route.fetch(new Request(`https://workspace.example/api/clinical-review/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
  }
  return { ctx, routes, review, request }
}

const claim = { eventId: 'event-1', trigger: 'open', sourceSystem: 'emr', hospitalCode: '1001', inpatId: '123' }
const receipt = { sessionId: SessionId('clinical-123'), revision: 1, status: 'accepted' as const, dischargeBlocked: false as const }

describe('authenticated review route payloads', () => {
  it('admits exact claims and acknowledges review or refresh independently of discharge', async () => {
    const { review, request } = setup()
    const launch = vi.spyOn(review, 'launch').mockResolvedValue({ ...receipt, status: 'bound' })
    const trigger = vi.spyOn(review, 'trigger').mockResolvedValue(receipt)
    const opened = await request('launch', claim)
    expect(opened.status).toBe(200)
    expect(opened.headers.get('cache-control')).toBe('no-store')
    expect(launch).toHaveBeenCalledWith(claim, expect.any(AbortSignal))
    const accepted = await request('review', { sessionId: receipt.sessionId, eventId: 'review-1', trigger: 'discharge-order' })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual(receipt)
    expect(trigger).toHaveBeenCalledWith(receipt.sessionId, 'review-1', 'discharge-order', expect.any(AbortSignal))
    expect((await request('refresh', { sessionId: receipt.sessionId, eventId: 'refresh-1' })).status).toBe(202)
    expect(trigger).toHaveBeenCalledWith(receipt.sessionId, 'refresh-1', 'refresh', expect.any(AbortSignal))
  })

  it('rejects injected clinical text, invalid triggers, and oversized complete requests before admission', async () => {
    const { review, request } = setup(200)
    const launch = vi.spyOn(review, 'launch')
    const trigger = vi.spyOn(review, 'trigger')
    expect((await request('launch', { ...claim, clinicalText: 'browser supplied narrative' })).status).toBe(400)
    expect((await request('review', { sessionId: 's', eventId: 'r', trigger: 'open' })).status).toBe(400)
    expect((await request('launch', { ...claim, inpatId: 'x'.repeat(250) })).status).toBe(413)
    expect(launch).not.toHaveBeenCalled()
    expect(trigger).not.toHaveBeenCalled()
  })

  it('redacts unexpected failures and preserves typed denial without changing discharge', async () => {
    const { review, request } = setup()
    vi.spyOn(review, 'launch').mockRejectedValueOnce(new Error('database-secret diagnostic'))
      .mockRejectedValueOnce(new ClinicalReviewError('forbidden', 'This encounter is not authorized.'))
    const unavailable = await request('launch', claim)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.text()).not.toContain('database-secret')
    const forbidden = await request('launch', claim)
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toMatchObject({ error: { code: 'forbidden' }, dischargeBlocked: false })
  })

  it('removes all registered review routes when their owning scope is disposed', async () => {
    const { ctx, routes } = setup()
    expect(routes.size).toBe(4)
    await ctx.fiber.dispose()
    expect(routes.size).toBe(0)
  })
})
