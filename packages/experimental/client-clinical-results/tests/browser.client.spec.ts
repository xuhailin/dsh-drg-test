// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { config, result } from './fixtures.client.ts'

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/') })

async function bench(sidebar: boolean, send: typeof fetch = async () => Response.json(config)) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots')!
  slots.register({ name: 'root', children: { 'shell.page': { kind: 'keyed', scope: 'root' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' }, 'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' } } } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const removePage = vi.fn(), registerPage = vi.fn(() => removePage)
  ctx.provide('clientPages', { register: registerPage })
  const removeTab = vi.fn(), registerTab = vi.fn(() => removeTab)
  if (sidebar) {
    ctx.provide('sidebarRightTabs', { register: registerTab } as never)
    ctx.provide('sidebarRight', { openResource: vi.fn() } as never)
  }
  vi.stubGlobal('fetch', send)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  return { ctx, slots, fiber, registerPage, removePage, registerTab, removeTab }
}

describe('clinical result browser registrations', () => {
  it('reauthorizes the explicit direct-page revision after a connection generation replaces its cached read', async () => {
    window.history.replaceState(null, '', `/?page=clinical-results&sessionId=${result.sessionId}&resultId=${result.resultId}&revision=1`)
    vi.stubGlobal('opener', null)
    const send = vi.fn<typeof fetch>(async url => Response.json(url === 'api/clinical-results/config' ? config : result))
    const b = await bench(false, send)
    try {
      await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(2) })
      b.ctx.emit('connection/reset')
      await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(3) })
      expect(send.mock.calls.slice(1).map(call => call[0])).toEqual(['api/clinical-review/result', 'api/clinical-review/result'])
      const body = send.mock.calls[2]?.[1]?.body
      if (typeof body !== 'string') throw new Error('Result read requires a JSON body')
      expect(JSON.parse(body)).toMatchObject({
        sessionId: result.sessionId, resultId: result.resultId, revision: 1,
      })
    } finally { await b.ctx.fiber.dispose() }
  })

  it('registers an independent page without loading Conversation services, then withdraws its route and slot', async () => {
    const b = await bench(false)
    try {
      expect(inject).toEqual(['slots', 'locale', 'clientPages'])
      expect(b.registerPage).toHaveBeenCalledWith({ page: 'clinical-results', key: 'clinical-results' })
      expect(b.slots.entries('shell.page')).toHaveLength(1)
      expect(b.ctx.get('uiConversation')).toBeUndefined()
      expect(b.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
      await b.fiber.dispose()
      expect(b.slots.entries('shell.page')).toHaveLength(0)
      expect(b.removePage).toHaveBeenCalledOnce()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('contributes a registered existing Sidebar type, body and title only when the Sidebar is composed', async () => {
    const b = await bench(true)
    try {
      expect(b.registerTab).toHaveBeenCalledWith(expect.objectContaining({ kind: 'clinical-result', patterns: ['dsh-resource://clinical-result/**'] }))
      expect(b.slots.entries('sidebar.right.pane.tab')).toHaveLength(1)
      expect(b.slots.entries('sidebar.right.pane.tab.title')).toHaveLength(1)
      await b.fiber.dispose()
      expect(b.removeTab).toHaveBeenCalledOnce()
      expect(b.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
      expect(b.slots.entries('sidebar.right.pane.tab.title')).toHaveLength(0)
    } finally { await b.ctx.fiber.dispose() }
  })
})
