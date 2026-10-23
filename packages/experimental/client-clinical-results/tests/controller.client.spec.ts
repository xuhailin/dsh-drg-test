import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResultController } from '../src/client/controller.ts'
import { resultAddress, parseResultAddress, resultSelectionSchema, selectionFromSearch } from '../src/client/protocol.ts'
import { config, listing, reference, result } from './fixtures.client.ts'

const controllers: ResultController[] = []
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose() })
function create(send: typeof fetch) {
  const controller = new ResultController(config, send)
  controllers.push(controller)
  return controller
}
function deferred<T>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>((value) => { resolve = value }); return { resolve, promise } }

describe('saved-result reference parsing', () => {
  it('round-trips the selected revision and rejects malformed or incomplete references', () => {
    expect(parseResultAddress(resultAddress(reference))).toEqual({ sessionId: reference.sessionId, resultId: reference.resultId,
      revision: 1 })
    expect(parseResultAddress('dsh-resource://clinical-result/%xx/result/1')).toBeUndefined()
    expect(parseResultAddress('dsh-resource://clinical-result/session/result/01')).toBeUndefined()
    expect(selectionFromSearch('?sessionId=s&resultId=r')).toBeUndefined()
    expect(selectionFromSearch('?sessionId=s&resultId=r&revision=2')).toMatchObject({ sessionId: 's', resultId: 'r', revision: 2 })
    expect(selectionFromSearch('?sessionId=s&resultId=r&revision=1e2')).toBeUndefined()
  })
})

describe('saved-result view request ownership', () => {
  it('loads exact saved content and lists revisions without selecting the newest or calling a model', async () => {
    const send = vi.fn<typeof fetch>(async url => Response.json((typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/results') ? listing : result))
    const controller = create(send)
    await controller.open({ sessionId: reference.sessionId, encounterRef: reference.encounterRef })
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'choose', result: null, listing })
    expect(send).toHaveBeenCalledOnce()
    await controller.select(reference)
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'ready', result, selection: reference })
    expect(send.mock.calls.map(call => call[0])).toEqual(['api/clinical-review/results', 'api/clinical-review/result'])
    expect(JSON.parse(send.mock.calls[1]![1]!.body as string)).toEqual(reference)
  })

  it('keeps the selected report when the next read fails and clears content on lost authentication or permission', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(result))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json(result)).mockResolvedValueOnce(new Response(null, { status: 403 }))
    const controller = create(send)
    await controller.open(reference); await controller.refresh()
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'failed', result })
    await controller.refresh()
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'login', result: null, listing: null })
    await controller.open(reference); await controller.refresh()
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'denied', result: null, listing: null })
  })

  it.each([{ status: 404, phase: 'not-found' }, { status: 415, phase: 'unsupported' }, { status: 503, phase: 'failed' }])
  ('renders HTTP $status as $phase', async ({ status, phase }) => {
    const controller = create(async () => new Response(null, { status }))
    await controller.open(reference)
    expect(controller.view.getSnapshot()).toMatchObject({ phase, result: null })
  })

  it('rejects unknown formats and cross-session responses without rendering their content', async () => {
    const controller = create(vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...result, schemaVersion: 2 }))
      .mockResolvedValueOnce(Response.json({ ...result, sessionId: 'other-session' })))
    await controller.open(reference)
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'unsupported', result: null })
    await controller.open(reference)
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'failed', result: null })
  })

  it('discards delayed reads after changing patients, clearing the view, or disposing', async () => {
    const first = deferred<Response>(), second = deferred<Response>()
    const controller = create(vi.fn<typeof fetch>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise))
    const a = controller.open(reference)
    const other = resultSelectionSchema.parse({ sessionId: 'other-session' })
    const b = controller.open(other)
    first.resolve(Response.json(result)); await a
    expect(controller.view.getSnapshot()).toMatchObject({ selection: other, result: null })
    controller.clear(); second.resolve(Response.json({ ...listing, sessionId: 'other-session' })); await b
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'idle', selection: null, result: null })
    controller.dispose(); await controller.open(reference)
    expect(controller.view.getSnapshot().phase).toBe('idle')
  })

  it('shows a distinct empty listing without requesting a report', async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ ...listing, results: [] }))
    const controller = create(send)
    await controller.open({ sessionId: reference.sessionId })
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'empty', result: null })
    expect(send).toHaveBeenCalledOnce()
  })

  it('shares duplicate pending reruns, preserves history selection, and reports uncertain admission without retrying', async () => {
    const admission = deferred<Response>()
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(result)).mockReturnValueOnce(admission.promise)
    const controller = create(send)
    await controller.open(reference)
    const first = controller.rerun('request-1'), second = controller.rerun('request-1')
    expect(first).toBe(second)
    expect(controller.view.getSnapshot()).toMatchObject({ result, rerun: 'pending' })
    admission.resolve(Response.json({ sessionId: reference.sessionId, revision: 3, status: 'accepted', requestId: 'request-1', dischargeBlocked: false }))
    expect(await first).toMatchObject({ status: 'accepted', revision: 3 })
    expect(controller.view.getSnapshot()).toMatchObject({ result, rerun: 'accepted', selection: reference })
    send.mockRejectedValueOnce(new Error('connection-lost'))
    await controller.rerun('request-2')
    expect(controller.view.getSnapshot()).toMatchObject({ result, rerun: 'unknown' })
    await controller.rerun('request-3')
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('cannot republish a late admission in a different encounter', async () => {
    const admission = deferred<Response>()
    const controller = create(vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(result)).mockReturnValueOnce(admission.promise))
    await controller.open(reference)
    const request = controller.rerun('request-1')
    controller.clear()
    admission.resolve(Response.json({ sessionId: reference.sessionId, revision: 3, status: 'accepted', requestId: 'request-1', dischargeBlocked: false }))
    await request
    expect(controller.view.getSnapshot()).toMatchObject({ phase: 'idle', result: null, rerun: 'idle' })
  })
})
