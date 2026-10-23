import { afterEach, describe, expect, it, vi } from 'vitest'
import { SavedCardController } from '../src/client/saved-cards.ts'
import { config, reference, result } from './fixtures.client.ts'

const controllers: SavedCardController[] = []
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose() })
function create(send: typeof fetch) {
  const controller = new SavedCardController(config, send)
  controllers.push(controller)
  return controller
}
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>((value) => { resolve = value }); return { resolve, promise } }

describe('durable saved card confirmation', () => {
  it('publishes no card while a read waits behind report persistence, then publishes only the confirmed immutable revision', async () => {
    const committed = deferred<Response>(), send = vi.fn<typeof fetch>(() => committed.promise)
    const controller = create(send)
    const request = controller.confirm(reference, result.reportId)
    expect(controller.view.getSnapshot().confirmed).toEqual({})
    expect(controller.confirm(reference, result.reportId)).toBe(request)
    expect(send).toHaveBeenCalledOnce()
    committed.resolve(Response.json(result)); await request
    expect(controller.view.getSnapshot().confirmed[result.reportId]).toMatchObject({ ref: reference, reportId: result.reportId,
      generatedAt: result.generatedAt, findingCount: 1, coverageGaps: 2 })
  })

  it.each([403, 404, 503])('does not publish raw report metadata when confirmation returns HTTP %s', async (status) => {
    const controller = create(async () => new Response(null, { status }))
    await controller.confirm(reference, result.reportId)
    expect(controller.view.getSnapshot()).toMatchObject({ confirmed: {}, unavailable: { [result.reportId]: true } })
  })

  it('rejects a report mismatch and permits an explicit read retry without repeating analysis', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...result, reportId: 'different' })).mockResolvedValueOnce(Response.json(result))
    const controller = create(send)
    await controller.confirm(reference, result.reportId)
    expect(controller.view.getSnapshot().confirmed).toEqual({})
    await controller.confirm(reference, result.reportId, true)
    expect(controller.view.getSnapshot().confirmed[result.reportId]?.reportId).toBe(result.reportId)
    expect(send.mock.calls.map(call => call[0])).toEqual(['api/clinical-review/result', 'api/clinical-review/result'])
  })

  it('discards pending confirmations and clinical metadata on connection or account invalidation', async () => {
    const committed = deferred<Response>(), controller = create(() => committed.promise)
    const request = controller.confirm(reference, result.reportId)
    controller.clear()
    committed.resolve(Response.json(result)); await request
    expect(controller.view.getSnapshot()).toEqual({ epoch: 1, confirmed: {}, unavailable: {} })
    controller.dispose()
    await controller.confirm(reference, result.reportId)
    expect(controller.view.getSnapshot().confirmed).toEqual({})
  })
})
