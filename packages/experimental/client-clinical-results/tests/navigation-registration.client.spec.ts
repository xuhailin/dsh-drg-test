// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../src/client/index.ts'
import { config } from './fixtures.client.ts'

const contexts: Context[] = []
afterEach(async () => {
  try { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) }
  finally { vi.unstubAllGlobals() }
})

function tracked<T>(source: ObservableSnapshot<T>) {
  const listeners = new Set<() => void>()
  return {
    listeners,
    getSnapshot: vi.fn(() => source.getSnapshot()),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      const stop = source.subscribe(listener)
      return () => { listeners.delete(listener); stop() }
    },
  }
}

async function bench(preset = 'clinical-pathway-analysis', duplicate = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.slots
  const declare = () => slots.register({ name: 'root', children: {
    'shell.page': { kind: 'keyed', scope: 'root' },
    'main': { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const removeDeclaration = declare()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('clientPages', { register: () => () => undefined })
  const sessionId = SessionId('selected-session')
  const sessions = createSnapshotStore({
    ids: [sessionId],
    byId: { [sessionId]: { id: sessionId, displayTitle: 'Selected', running: false,
      retainedBy: { mainView: 1 }, blank: true, updatedAt: 1, projectionValues: { agentPreset: preset } } },
    phase: 'ready' as const, projectionsBySession: {},
  })
  const panel = createSnapshotStore<PanelInfo>({ activePanelId: null })
  const sessionSource = tracked(sessions), panelSource = tracked(panel)
  ctx.provide('sessions', { list: sessionSource } as never)
  ctx.provide('layout', { panelInfo: panelSource } as never)
  ctx.provide('uiWorkspace', { openSession: vi.fn() } as never)
  if (duplicate) slots.register({ name: 'sidebar.panellist', id: 'clinical-patients', label: () => 'Existing', order: 20 }, () => null)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
    if (url !== 'api/clinical-results/config') throw new Error('Unexpected fixture request')
    return Response.json(config)
  }))
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  const selectPreset = (value: string) => { sessions.update((state) => { state.byId[sessionId]!.projectionValues.agentPreset = value }) }
  return { ctx, slots, fiber, sessions, panel, sessionSource, panelSource, declare, removeDeclaration, selectPreset }
}

describe('clinical patient sidebar registration', () => {
  it('follows clinical context without removing the patient panel or duplicating its entry', async () => {
    const b = await bench()
    expect(b.slots.entries('main')).toHaveLength(1)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    b.selectPreset('clinical-review')
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
    b.sessions.update((state) => { state.byId[SessionId('selected-session')]!.updatedAt = 2 })
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
    b.panel.set({ activePanelId: 'another-panel' as MainPanelId })
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    b.panel.set({ activePanelId: 'clinical-patients' as MainPanelId })
    b.selectPreset('standard')
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
    b.panel.set({ activePanelId: null })
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    b.selectPreset('clinical-review')
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
    b.sessions.update((state) => { state.byId = {}; state.ids = [] })
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(b.slots.entries('main')).toHaveLength(1)
  })

  it('withdraws subscriptions on slot removal, reload and plugin disposal', async () => {
    const b = await bench('clinical-review')
    expect(b.sessionSource.listeners.size).toBe(1)
    expect(b.panelSource.listeners.size).toBe(1)
    b.removeDeclaration()
    expect(b.sessionSource.listeners.size).toBe(0)
    expect(b.panelSource.listeners.size).toBe(0)
    b.declare()
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
    expect(b.sessionSource.listeners.size).toBe(1)
    expect(b.panelSource.listeners.size).toBe(1)
    await b.fiber.restart()
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
    expect(b.sessionSource.listeners.size).toBe(1)
    expect(b.panelSource.listeners.size).toBe(1)
    await b.fiber.dispose()
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.sessionSource.listeners.size).toBe(0)
    expect(b.panelSource.listeners.size).toBe(0)
    b.sessionSource.getSnapshot.mockClear()
    b.panelSource.getSnapshot.mockClear()
    b.selectPreset('standard')
    b.panel.set({ activePanelId: 'clinical-patients' as MainPanelId })
    expect(b.sessionSource.getSnapshot).not.toHaveBeenCalled()
    expect(b.panelSource.getSnapshot).not.toHaveBeenCalled()
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
  })

  it('releases both subscriptions if initial entry registration conflicts', async () => {
    const b = await bench('clinical-review', true)
    const outcomes = await Promise.allSettled([...b.ctx.registry.values()]
      .flatMap(runtime => [...runtime.fibers]).map(fiber => fiber.await()))
    expect(outcomes.some(outcome => outcome.status === 'rejected'
      && outcome.reason instanceof Error && outcome.reason.message.includes('clinical-patients'))).toBe(true)
    expect(b.sessionSource.listeners.size).toBe(0)
    expect(b.panelSource.listeners.size).toBe(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(1)
  })
})
