import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EntryActions } from '../src/client/actions.ts'
import { parseLaunchMessage } from '../src/client/protocol.ts'
import type { EntryConfig } from '../src/types.ts'

const config: EntryConfig = {
  allowedOrigins: ['https://emr.example'], defaultSourceSystem: 'emr', defaultHospitalCode: 'test',
  requestTimeoutMs: 1000, maxPendingRequests: 2, maxMessageBytes: 8192,
}
const claim = { eventId: 'event-1', trigger: 'open' as const, sourceSystem: 'emr', hospitalCode: 'test', inpatId: '42' }
const receipt = (sessionId = 'session-1') => Response.json({ sessionId, status: 'bound', revision: 0, dischargeBlocked: false })
const progress = (sessionId = 'session-1') => ({ sessionId, revision: 2, status: 'failed', reportAvailable: false,
  durability: 'confirmed', dischargeBlocked: false, operations: [{ revision: 2, status: 'failed', errorCode: 'report-not-submitted' }] })

describe('EMR entry requests', () => {
  it('calls the browser transport without rebinding its receiver to the entry controller', async () => {
    const send = function (this: unknown): Promise<Response> {
      if (this !== undefined) throw new TypeError('Illegal invocation')
      return Promise.resolve(receipt())
    }
    const open = vi.fn()
    const actions = new EntryActions(config, send, open)
    try {
      await actions.launch(claim)
      expect(open).toHaveBeenCalledWith('session-1')
      expect(actions.view.getSnapshot().notice).toBe('opened')
    } finally { await actions.dispose() }
  })

  it('opens the returned private Session and admits review and refresh only on explicit actions', async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => receipt())
    const open = vi.fn()
    const actions = new EntryActions(config, send, open)
    actions.show()
    await actions.launch(claim)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]).toMatchObject(['/api/clinical-review/launch', {
      method: 'POST', credentials: 'same-origin', body: JSON.stringify(claim),
    }])
    expect(open).toHaveBeenCalledWith('session-1')
    expect(actions.view.getSnapshot()).toMatchObject({ open: false, busy: false, notice: 'opened' })
    await actions.review('session-1' as SessionId)
    await actions.refresh('session-1' as SessionId)
    expect(send.mock.calls.map(([url]) => url)).toEqual([
      '/api/clinical-review/launch', '/api/clinical-review/review', '/api/clinical-review/refresh',
    ])
    expect(JSON.parse(send.mock.calls[1]![1]!.body as string)).toMatchObject({ sessionId: 'session-1', trigger: 'manual-review' })
    expect(actions.view.getSnapshot().notice).toBe('refreshed')
    actions.dismiss()
    expect(actions.view.getSnapshot().notice).toBeNull()
    await actions.dispose()
  })

  it('coalesces repeated pending events, bounds concurrency, and keeps the latest requested Session selected', async () => {
    const completions: ((response: Response) => void)[] = []
    const send = vi.fn<typeof fetch>(() => new Promise((resolve) => { completions.push(resolve) }))
    const open = vi.fn()
    const actions = new EntryActions(config, send, open)
    const first = actions.launch(claim)
    expect(actions.launch(claim)).toBe(first)
    await expect(actions.launch({ ...claim, inpatId: 'changed' })).rejects.toThrow('EMR_ENTRY_BUSY')
    const second = actions.launch({ ...claim, eventId: 'event-2' })
    await expect(actions.launch({ ...claim, eventId: 'event-3' })).rejects.toThrow('EMR_ENTRY_BUSY')
    completions[1]!(receipt('second'))
    await second
    completions[0]!(receipt('first'))
    await first
    expect(open.mock.calls).toEqual([['second']])
    expect(send).toHaveBeenCalledTimes(2)
    await actions.dispose()
  })

  it.each([
    new Response('denied', { status: 403 }),
    Response.json({ sessionId: 'bad', dischargeBlocked: true }),
  ])('keeps the form visible and reports a refused or invalid result', async (response) => {
    const open = vi.fn()
    const actions = new EntryActions(config, async () => response, open)
    actions.show()
    await expect(actions.launch(claim)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    expect(actions.view.getSnapshot()).toMatchObject({ open: true, busy: false, notice: 'failed' })
    await actions.dispose()
  })

  it('reports navigation failure without losing the accepted request outcome silently', async () => {
    const actions = new EntryActions(config, async () => receipt(), () => { throw new Error('navigation unavailable') })
    actions.show()
    await expect(actions.launch(claim)).rejects.toThrow('navigation unavailable')
    expect(actions.view.getSnapshot()).toMatchObject({ open: true, notice: 'failed' })
    await actions.dispose()
  })

  it('cancels and drains pending requests on disposal without late navigation or notices', async () => {
    const open = vi.fn()
    const actions = new EntryActions(config, (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }), open)
    const pending = actions.launch(claim)
    const observed = expect(pending).rejects.toThrow()
    await actions.dispose()
    await observed
    expect(open).not.toHaveBeenCalled()
    expect(actions.view.getSnapshot()).toMatchObject({ busy: false, notice: null })
    await expect(actions.launch(claim)).rejects.toThrow('EMR_ENTRY_BUSY')
  })

  it('bounds response waiting by the configured timeout and keeps discharge unaffected', async () => {
    const actions = new EntryActions({ ...config, requestTimeoutMs: 10 }, (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }), vi.fn())
    await expect(actions.launch(claim)).rejects.toThrow()
    expect(actions.view.getSnapshot()).toMatchObject({ busy: false, notice: 'failed' })
    await actions.dispose()
  })
})

describe('encounter review status', () => {
  it('reads progress without a model request or transport receiver and discards clinical fields', async () => {
    const send = vi.fn(function (this: unknown, url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) {
      if (this !== undefined) throw new TypeError('Illegal invocation')
      expect(url).toBe('/api/clinical-review/status')
      expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ sessionId: 'session-1' }) })
      return Promise.resolve(Response.json({ ...progress(), report: { summary: 'Not UI data' } }))
    })
    const open = vi.fn()
    const actions = new EntryActions(config, send, open)
    try {
      actions.show('session-1' as SessionId)
      await vi.waitFor(() => { expect(actions.view.getSnapshot().statusPhase).toBe('ready') })
      expect(actions.view.getSnapshot().status).toEqual(progress())
      expect(open).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledOnce()
      await actions.updateStatus()
      expect(send).toHaveBeenCalledTimes(2)
    } finally { await actions.dispose() }
  })

  it.each([
    { response: () => Response.json({ error: { code: 'unbound-session' } }, { status: 503 }), phase: 'unbound' },
    { response: () => new Response('private diagnostic', { status: 403 }), phase: 'denied' },
    { response: () => Response.json({ error: { code: 'source-unavailable' } }, { status: 503 }), phase: 'unavailable' },
    { response: () => Response.json({ ...progress(), sessionId: 'other-session' }), phase: 'unavailable' },
    { response: () => Response.json({ ...progress(), dischargeBlocked: true }), phase: 'unavailable' },
  ])('distinguishes $phase status reads without marking the clinical operation failed', async ({ response, phase }) => {
    const actions = new EntryActions(config, async () => response(), vi.fn())
    try {
      actions.show('session-1' as SessionId)
      await vi.waitFor(() => { expect(actions.view.getSnapshot().statusPhase).toBe(phase) })
      expect(actions.view.getSnapshot()).toMatchObject({ status: null, notice: null })
    } finally { await actions.dispose() }
  })

  it('keeps the last retrieved metadata after a bounded status query times out', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(progress()))
      .mockImplementation((_url, options) => new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }))
    const actions = new EntryActions({ ...config, requestTimeoutMs: 10 }, send, vi.fn())
    try {
      actions.show('session-1' as SessionId)
      await vi.waitFor(() => { expect(actions.view.getSnapshot().statusPhase).toBe('ready') })
      await actions.updateStatus()
      expect(actions.view.getSnapshot()).toMatchObject({ statusPhase: 'unavailable', status: progress(), notice: null })
    } finally { await actions.dispose() }
  })

  it('ignores old metadata after switching sessions, closing, or unloading', async () => {
    const completions: ((response: Response) => void)[] = []
    const send = vi.fn<typeof fetch>(() => new Promise((resolve) => { completions.push(resolve) }))
    const actions = new EntryActions(config, send, vi.fn())
    actions.show('first' as SessionId)
    actions.show('second' as SessionId)
    completions[1]!(Response.json(progress('second')))
    await vi.waitFor(() => { expect(actions.view.getSnapshot().statusPhase).toBe('ready') })
    completions[0]!(Response.json(progress('first')))
    await vi.waitFor(() => { expect(actions.view.getSnapshot().status?.sessionId).toBe('second') })
    const closing = actions.updateStatus()
    actions.close()
    completions[2]!(Response.json(progress('second')))
    await closing
    expect(actions.view.getSnapshot()).toMatchObject({ open: false, statusPhase: 'idle', status: null })
    actions.show('third' as SessionId)
    const before = actions.view.getSnapshot()
    const disposed = actions.dispose()
    completions[3]!(Response.json(progress('third')))
    await disposed
    expect(actions.view.getSnapshot()).toBe(before)
  })

  it('does not navigate or replace a new view with an old admission receipt', async () => {
    let finish!: (response: Response) => void
    const actions = new EntryActions(config, () => new Promise((resolve) => { finish = resolve }), vi.fn())
    const pending = actions.launch(claim)
    actions.show()
    finish(receipt())
    await pending
    expect(actions.view.getSnapshot()).toMatchObject({ open: true, sessionId: null, notice: null })
    await actions.dispose()
  })
})

describe('EMR window message validation', () => {
  const message = { type: 'dsh.emr.launch', value: claim }
  it('accepts identifier-only context and preserves its explicit trigger', () => {
    expect(parseLaunchMessage(message, 8192)).toEqual(claim)
    expect(parseLaunchMessage({ ...message, value: { ...claim, trigger: 'discharge-order' } }, 8192)?.trigger).toBe('discharge-order')
  })
  it.each([
    null, { ...message, value: { ...claim, notes: 'clinical text' } },
    { ...message, value: { ...claim, inpatId: '' } }, { ...message, extra: true },
    { ...message, value: { ...claim, trigger: 'discharge' } },
  ])('refuses malformed or expanded messages', (data) => { expect(parseLaunchMessage(data, 8192)).toBeUndefined() })
  it('enforces the whole message byte limit', () => { expect(parseLaunchMessage(message, 2)).toBeUndefined() })
})
