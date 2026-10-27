// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EntryButton, ReviewButton } from '../src/client/Entry.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function navigation(preset: string | null | undefined, blank = true) {
  const sessionId = 'selected-session' as SessionId
  const sessions = createSnapshotStore({
    ids: [sessionId],
    byId: {
      [sessionId]: {
        id: sessionId, displayTitle: 'Selected', running: false, blank, updatedAt: 1,
        retainedBy: { mainView: 1 },
        projectionValues: preset === undefined ? undefined : { agentPreset: preset },
      },
    },
    phase: 'ready' as const,
    projectionsBySession: {},
  })
  const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: null })
  const show = vi.fn()
  const shared = { useSessions: bindSnapshotSelector(sessions), show, t: makeTranslate(zh, commonZh) }
  const entry = { ...shared, wide: true, usePanelInfo: bindSnapshotSelector(panelInfo) } as ComponentProps<typeof EntryButton>
  const review = { ...shared, sessionId } as ComponentProps<typeof ReviewButton>
  return { sessionId, sessions, panelInfo, show, entry, review }
}

function expectControls(visible: boolean) {
  for (const name of [zh.entry, zh.review]) {
    expect(screen.queryByRole('button', { name }) !== null).toBe(visible)
  }
}

describe('encounter navigation context', () => {
  it.each([true, false])('opens entry and review for a clinical-review Session with blank=%s', (blank) => {
    const b = navigation('clinical-review', blank)
    render(<><EntryButton {...b.entry} /><ReviewButton {...b.review} /></>)
    expectControls(true)
    fireEvent.click(screen.getByRole('button', { name: zh.entry }))
    fireEvent.click(screen.getByRole('button', { name: zh.review }))
    expect(b.show.mock.calls).toEqual([[], [b.sessionId]])
  })

  it.each(['clinical-pathway-analysis', 'standard', 'unrecognized-preset', null, undefined])('hides both controls for preset %s', (preset) => {
    const b = navigation(preset)
    render(<><EntryButton {...b.entry} /><ReviewButton {...b.review} /></>)
    expectControls(false)
  })

  it('tracks preset changes and hides controls while the selected summary is absent', () => {
    const b = navigation('clinical-review')
    render(<><EntryButton {...b.entry} /><ReviewButton {...b.review} /></>)
    expectControls(true)
    for (const preset of ['clinical-pathway-analysis', 'standard', 'clinical-review']) {
      act(() => { b.sessions.update((state) => { state.byId[b.sessionId]!.projectionValues = { agentPreset: preset } }) })
      expectControls(preset === 'clinical-review')
    }
    act(() => { b.sessions.update((state) => { state.byId = {}; state.ids = [] }) })
    expectControls(false)
  })

  it('uses the header Session rather than another selected clinical-review Session', () => {
    const b = navigation('clinical-review')
    const otherId = 'other-session' as SessionId
    const mounted = render(<ReviewButton {...b.review} sessionId={otherId} />)
    expect(screen.queryByRole('button', { name: zh.review })).toBeNull()
    act(() => {
      b.sessions.update((state) => {
        state.byId[otherId] = { ...state.byId[b.sessionId]!, id: otherId, retainedBy: { mainView: 0 }, projectionValues: { agentPreset: 'clinical-pathway-analysis' } }
      })
    })
    expect(screen.queryByRole('button', { name: zh.review })).toBeNull()
    mounted.rerender(<ReviewButton {...b.review} />)
    expect(screen.getByRole('button', { name: zh.review })).toBeTruthy()
  })

  it('shows entry on the clinical patient panel without leaking to other panels or retained history', () => {
    const b = navigation('clinical-review')
    render(<EntryButton {...b.entry} />)
    expect(screen.getByRole('button', { name: zh.entry })).toBeTruthy()
    act(() => { b.panelInfo.set({ activePanelId: 'other-panel' as MainPanelId }) })
    expect(screen.queryByRole('button', { name: zh.entry })).toBeNull()
    act(() => {
      b.sessions.update((state) => { state.byId[b.sessionId]!.projectionValues = { agentPreset: 'clinical-pathway-analysis' } })
      b.panelInfo.set({ activePanelId: 'clinical-patients' as MainPanelId })
    })
    expect(screen.getByRole('button', { name: zh.entry })).toBeTruthy()
    act(() => { b.sessions.update((state) => { state.byId = {}; state.ids = [] }) })
    expect(screen.getByRole('button', { name: zh.entry })).toBeTruthy()
    act(() => { b.panelInfo.set({ activePanelId: null }) })
    expect(screen.queryByRole('button', { name: zh.entry })).toBeNull()
    const clinical = navigation('clinical-review').sessions.getSnapshot().byId[b.sessionId]!
    act(() => { b.sessions.update((state) => { state.byId[b.sessionId] = { ...clinical, retainedBy: { mainView: 0 } } }) })
    expect(screen.queryByRole('button', { name: zh.entry })).toBeNull()
  })
})
