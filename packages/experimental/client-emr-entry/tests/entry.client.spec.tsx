// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EntryActions } from '../src/client/actions.ts'
import { EntryOverlay, type EntryInjected } from '../src/client/Entry.tsx'
import { zh } from '../src/client/locales.ts'

const config = {
  allowedOrigins: [], defaultSourceSystem: 'emr', defaultHospitalCode: 'test',
  requestTimeoutMs: 1000, maxPendingRequests: 2, maxMessageBytes: 8192,
}
const controllers: EntryActions[] = []
afterEach(async () => { cleanup(); await Promise.all(controllers.splice(0).map(actions => actions.dispose())) })

const metadata = { sessionId: 'bound', revision: 0, status: 'bound', reportAvailable: false, durability: 'confirmed', dischargeBlocked: false, operations: [] }
function bench(result: object = metadata, responseStatus = 200) {
  const actions = new EntryActions(config, async () => Response.json(result, { status: responseStatus }), vi.fn())
  controllers.push(actions)
  const launch = vi.fn<EntryInjected['launch']>()
  const review = vi.fn()
  const refresh = vi.fn()
  const updateStatus = vi.fn(() => { void actions.updateStatus() })
  const props = {
    useEntry: bindSnapshotSelector(actions.view), config,
    close: () => { actions.close() }, dismiss: () => { actions.dismiss() },
    launch, review, refresh, updateStatus, t: makeTranslate(zh, commonZh),
  } as ComponentProps<typeof EntryOverlay>
  actions.show()
  render(<EntryOverlay {...props} />)
  return { actions, launch, review, refresh, updateStatus }
}

describe('encounter entry controls', () => {
  it('submits identifier-only open context, then exposes separate status, review and evidence actions', async () => {
    const b = bench()
    expect(screen.getByRole('button', { name: zh.open })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: zh.start })).toBeNull()
    fireEvent.change(screen.getByLabelText(zh.inpatId), { target: { value: '42' } })
    fireEvent.change(screen.getByLabelText(zh.inpatCode), { target: { value: ' admission ' } })
    fireEvent.click(screen.getByRole('button', { name: zh.open }))
    expect(typeof b.launch.mock.calls[0]![0].eventId).toBe('string')
    expect(b.launch.mock.calls[0]![0]).toMatchObject({ trigger: 'open', sourceSystem: 'emr', hospitalCode: 'test', inpatId: '42', inpatCode: 'admission',
    })
    expect(b.review).not.toHaveBeenCalled()
    act(() => { b.actions.show('bound' as SessionId) })
    await waitFor(() => { expect(screen.getByText(zh.statusBound, { exact: false })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.start }))
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect(b.review).toHaveBeenCalledWith('bound')
    expect(b.refresh).toHaveBeenCalledWith('bound')
    expect(screen.getByText(zh.hint)).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toMatchInlineSnapshot(
      '"出院前核查核查结果显示在聊天中，不阻断出院；DRG／DIP 预分组尚未接入已接入就诊，尚未核查核查版本：0更新状态开始核查刷新证据打开另一份就诊来源系统医院编码住院记录 ID住院流水号（选填）只填写就诊标识。打开会话不会读取病历正文或调用模型打开就诊会话"',
    )
    fireEvent.click(screen.getByRole('button', { name: zh.updateStatus }))
    expect(b.updateStatus).toHaveBeenCalledOnce()
    expect(b.review).toHaveBeenCalledOnce()
    expect(b.refresh).toHaveBeenCalledOnce()
  })

  it.each([
    { status: 'failed', reportAvailable: false, errorCode: 'report-not-submitted', text: zh.statusNotSubmitted },
    { status: 'failed', reportAvailable: false, errorCode: 'model-turn-max-tokens', text: zh.statusMaxTokens },
    { status: 'reviewed', reportAvailable: true, errorCode: undefined, text: zh.statusReviewed },
  ])('shows $status report metadata and its revision without clinical content', async ({ status, reportAvailable, errorCode, text }) => {
    const b = bench({ ...metadata, revision: 2, status, reportAvailable, operations: [{ revision: 2, status: 'failed', errorCode }], report: { summary: 'PRIVATE_CLINICAL_TEXT' } })
    act(() => { b.actions.show('bound' as SessionId) })
    await waitFor(() => { expect(screen.getByText(text, { exact: false })).toBeTruthy() })
    expect(screen.getByText(`${zh.revision}2`, { exact: false })).toBeTruthy()
    expect(screen.queryByText('PRIVATE_CLINICAL_TEXT')).toBeNull()
    expect(screen.getByText(zh.hint)).toBeTruthy()
  })

  it('shows an unbound ordinary chat and keeps the encounter entry form available', async () => {
    const b = bench({ error: { code: 'unbound-session' } }, 503)
    act(() => { b.actions.show('bound' as SessionId) })
    await waitFor(() => { expect(screen.getByText(zh.statusUnbound)).toBeTruthy() })
    expect(screen.getByRole('button', { name: zh.start })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(zh.inpatId)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.updateStatus })).toHaveProperty('disabled', false)
  })

  it('closes by Escape while preserving notices in the persistent overlay', () => {
    const b = bench()
    act(() => { b.actions.view.update((value) => { value.notice = 'failed' }) })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(zh.failed)
  })
})
