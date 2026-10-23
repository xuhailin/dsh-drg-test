// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as plugin from '../src/client/index.ts'

const config = {
  allowedOrigins: ['https://emr.example'], defaultSourceSystem: 'emr', defaultHospitalCode: 'test',
  requestTimeoutMs: 1000, maxPendingRequests: 2, maxMessageBytes: 8192,
}
const claim = { eventId: 'event', trigger: 'open', sourceSystem: 'emr', hospitalCode: 'test', inpatId: '42' }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function bench() {
  const ctx = new Context()
  const open = vi.fn()
  const parent = { postMessage: vi.fn() }
  vi.stubGlobal('opener', parent)
  const send = vi.fn<typeof fetch>().mockImplementation(async url => url === '/api/emr-entry/config'
    ? Response.json(config)
    : Response.json({ sessionId: 'private-session', revision: 0, status: 'bound', dischargeBlocked: false, clinicalBody: 'omitted' }))
  vi.stubGlobal('fetch', send)
  ctx.provide('uiWorkspace', { openSession: open } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: {
    'sidebar.footer.action': { kind: 'list', scope: 'global' },
    'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    'shell.overlay': { kind: 'list', scope: 'global' },
  } } as never, () => null)
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  cleanup.push(() => ctx.fiber.dispose())
  const dispatch = (origin: string, source: object, data: unknown = { type: 'dsh.emr.launch', value: claim }) => {
    window.dispatchEvent(new MessageEvent('message', { origin, source: source as Window, data }))
  }
  return { ctx, fiber, parent, send, open, dispatch }
}

describe('EMR browser entry plugin', () => {
  it('accepts only the configured origin on the bound opening window and replies with metadata', async () => {
    const b = await bench()
    expect(b.parent.postMessage).toHaveBeenCalledWith({ type: 'dsh.emr.ready' }, 'https://emr.example')
    b.dispatch('https://foreign.example', b.parent)
    b.dispatch('https://emr.example', {})
    b.dispatch('https://emr.example', b.parent, { type: 'dsh.emr.launch', value: { ...claim, patient: {} } })
    expect(b.send).toHaveBeenCalledOnce()
    b.dispatch('https://emr.example', b.parent)
    await vi.waitFor(() => { expect(b.open).toHaveBeenCalledWith('private-session') })
    expect(b.send.mock.calls[1]![1]?.credentials).toBe('same-origin')
    expect(b.parent.postMessage).toHaveBeenLastCalledWith({
      type: 'dsh.emr.launch.result', eventId: 'event', sessionId: 'private-session', status: 'bound', dischargeBlocked: false,
    }, 'https://emr.example')
    expect(b.ctx.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(b.ctx.slots.entries('conversation.session.header.actions')).toHaveLength(1)
    await b.fiber.dispose()
    expect(b.ctx.slots.entries('sidebar.footer.action')).toHaveLength(0)
    b.dispatch('https://emr.example', b.parent)
    expect(b.send).toHaveBeenCalledTimes(2)
  })

  it('contains request failures and sends no patient details to the opening window', async () => {
    const b = await bench()
    b.send.mockRejectedValueOnce(new Error('private transport error'))
    b.dispatch('https://emr.example', b.parent)
    await vi.waitFor(() => { expect(b.parent.postMessage).toHaveBeenLastCalledWith({
      type: 'dsh.emr.launch.result', eventId: 'event', status: 'failed', dischargeBlocked: false,
    }, 'https://emr.example') })
    expect(b.open).not.toHaveBeenCalled()
  })
})
