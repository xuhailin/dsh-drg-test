// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ReferenceController } from '../src/client/controller.ts'
import { ReferenceButton, ReferenceOverlay, type ReferenceInjected } from '../src/client/Preview.tsx'
import { zh } from '../src/client/locales.ts'
import { identifiedObjects } from '../src/client/presentation.ts'
import { readDefinition } from '../src/emr/definition-reader.ts'
import type { ReferenceConfig, ReferenceState, ReferenceView } from '../src/types.ts'

const sessionId = SessionId('reference-session')
const timestamp = '2026-10-27T00:00:00Z'
const config: ReferenceConfig = { scope: { sourceSystem: 'emr', hospitalCode: '1001', departmentCodes: ['99999'],
  departmentBasis: 'current', admissionFrom: '2025-10-27T00:00:00Z', admissionTo: timestamp },
maxRequestBytes: 100000, maxStateBytes: 1000000, maxRevisions: 10 }
const controllers: ReferenceController[] = []
afterEach(() => { cleanup(); for (const controller of controllers.splice(0)) controller.dispose() })

function definition() {
  return readDefinition({ format: 'emr-clinical-pathway-definition', schemaVersion: 1, clinicalPathway: {
    localId: 'pathway', name: '合成参考路径', createDept: { code: '99999', name: '合成科室' },
    deptInfos: [{ localId: 'department', deptCode: '99999', deptName: '合成使用科室' }],
    feesRange: null, inpatDayRange: [1, 4],
    diagnoseGroup: [{ localId: 'diagnosis', code: 'SYN-D', name: '合成诊断' }],
    inclusionAssessment: [{ localId: 'assessment', inclusionItem: '合成准入条件', isInclude: true, required: true }],
    treatments: [{ localId: 'phase-a', name: '合成第1—2天', nodeAttribute: 0, clinicalAttributes: null,
      inpatDayRange: [1, 2], parentTreatmentLocalId: null, branchs: [],
      recordTreatmentProjects: [{ localId: 'document', projectType: 1, code: 'DOC', name: '合成诊疗工作', required: true }],
      nursingTreatmentProjects: [{ localId: 'nursing', projectType: 2, code: null, name: '合成护理工作', required: null }],
      orderTreatmentProjects: [
        { localId: 'bundle', projectType: 0, levelType: 3, name: '合成组包', children: [
          { localId: 'group', projectType: 0, levelType: 2, name: '合成组', children: [
            { localId: 'order-a', projectType: 0, levelType: 1, name: '同名合成药', specs: '规格A', onceDose: { value: 0, adjustable: false }, unit: { code: 'u', name: '合成单位' } },
            { localId: 'order-b', projectType: 0, levelType: 1, name: '同名合成药', specs: '规格B', onceDose: null },
          ] },
        ] },
        { localId: 'herbal-order', projectType: 0, levelType: 1, name: '合成整方项目', herbalRecipe: {
          localId: 'recipe', orderName: '合成处方头', drugCount: null, detail: [
            { localId: 'herb-a', drugCode: 'H1', drugName: '合成药味一', onceDose: 0, doseUnitCode: null, doseUnitName: '合成单位' },
            { localId: 'herb-b', drugCode: null, drugName: '未匹配合成药味', onceDose: null, doseUnitCode: null, doseUnitName: null },
          ],
        } },
      ] },
    { localId: 'phase-b', name: '合成第3—4天', nodeAttribute: 0, clinicalAttributes: null,
      inpatDayRange: [3, 4], parentTreatmentLocalId: 'phase-a', recordTreatmentProjects: null,
      nursingTreatmentProjects: [], orderTreatmentProjects: [], branchs: [{ localId: 'branch', name: '未读关联路径',
        relatedClinicalPathwayId: 7, relatedClinicalPathwayLocalId: null }] },
    ],
  } })
}
function state(): ReferenceState {
  const baseline = definition()
  const current = definition()
  current.clinicalPathway.name = '修改后的合成路径'
  return { schemaVersion: 1, ownerSessionId: sessionId, mode: 'revision', title: '合成讨论任务', scope: config.scope, baseline,
    source: { eventSeq: 4, definitionId: 'exact-version-7', sourceSystem: 'emr', readAt: timestamp },
    revisions: [
      { revision: 1, requestId: 'request-1', requestDigest: 'a'.repeat(64), createdAt: timestamp, definition: baseline,
        metadata: { coverage: ['部分来源尚未读取'], questions: [{ localId: 'herb-b', field: 'drugCode', message: '药味未匹配' }],
          evidence: [{ localId: 'herb-b', sourceRef: 'source-fragment', observedAt: timestamp, kind: 'source' }] },
        locks: ['herb-b'], changedLocalIds: [], undoes: null },
      { revision: 2, requestId: 'request-2', requestDigest: 'b'.repeat(64), createdAt: timestamp, definition: current,
        metadata: { coverage: ['部分来源尚未读取'], questions: [{ localId: 'herb-b', field: 'drugCode', message: '药味未匹配' }],
          evidence: [{ localId: 'herb-b', sourceRef: 'source-fragment', observedAt: timestamp, kind: 'source' }] },
        locks: ['herb-b'], changedLocalIds: ['pathway'], undoes: null },
    ] }
}
function controller(send: typeof fetch) {
  const value = new ReferenceController(config, send)
  controllers.push(value)
  return value
}
function mount(value: ReferenceController, overrides: Partial<ReferenceInjected> = {}) {
  const props = { config, useReference: bindSnapshotSelector(value.view), close: () => { value.close() },
    refresh: () => { void value.refresh() }, create: (mode: 'new' | 'revision', title: string, seq?: number) => { void value.create(mode, title, seq) },
    t: makeTranslate(zh, commonZh), ...overrides,
  } as ComponentProps<typeof ReferenceOverlay>
  return render(<ReferenceOverlay {...props} />)
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred promise not initialized') }
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

describe('pathway reference preview', () => {
  it('limits the header entry to the clinical pathway preset and releases its Session on unmount', () => {
    const show = vi.fn(), leave = vi.fn(), observeRevision = vi.fn()
    const props = { sessionId, show, leave, observeRevision, t: makeTranslate(zh, commonZh),
      useSessions: (selector: (value: object) => unknown) => selector({ byId: { [sessionId]: { projectionValues: { agentPreset: 'other' } } } }),
    } as ComponentProps<typeof ReferenceButton>
    const rendered = render(<ReferenceButton {...props} />)
    expect(screen.queryByRole('button', { name: zh.entry })).toBeNull()
    rendered.rerender(<ReferenceButton {...props} useSessions={((selector: (value: object) => unknown) => selector({ byId: { [sessionId]: { projectionValues: { agentPreset: 'clinical-pathway-analysis' } } } })) as ComponentProps<typeof ReferenceButton>['useSessions']} />)
    fireEvent.click(screen.getByRole('button', { name: zh.entry }))
    expect(show).toHaveBeenCalledWith(sessionId)
    rendered.unmount()
    expect(leave).toHaveBeenCalledWith(sessionId)
  })

  it('invokes the browser fetch transport without a controller receiver', async () => {
    const receivers: unknown[] = []
    const send: typeof fetch = function (this: unknown) {
      receivers.push(this)
      return Promise.resolve(Response.json({ state: null, sources: [] }))
    }
    const value = controller(send)
    await value.show(sessionId)
    expect(receivers).toEqual([undefined])
  })

  it('creates only a task title and fixed scope, or selects an exact logged version with its coverage', async () => {
    const view: ReferenceView = { state: null, sources: [{ eventSeq: 4, definitionId: 'exact-version-7', label: '具体版本7', readAt: timestamp, coverage: ['部分读取'] }] }
    const value = controller(async () => Response.json(view))
    await value.show(sessionId)
    const create = vi.fn<ReferenceInjected['create']>()
    mount(value, { create })
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText(zh.taskTitle), { target: { value: '讨论某个参考任务' } })
    fireEvent.click(screen.getByRole('button', { name: zh.create }))
    expect(create).toHaveBeenCalledWith('new', '讨论某个参考任务', undefined)
    fireEvent.click(screen.getByRole('tab', { name: zh.revisionTask }))
    fireEvent.change(screen.getByLabelText(zh.source), { target: { value: '4' } })
    expect(screen.getByText('部分读取')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.create }))
    expect(create).toHaveBeenLastCalledWith('revision', '讨论某个参考任务', 4)
    fireEvent.click(screen.getByRole('tab', { name: zh.newTask }))
    fireEvent.click(screen.getByRole('button', { name: zh.create }))
    expect(create).toHaveBeenLastCalledWith('new', '讨论某个参考任务', undefined)
    expect(screen.getByText('99999')).toBeTruthy()
  })

  it('shows multiple phase rows, nested groups, complete prescriptions and unknown collections without clinical forms', async () => {
    const value = controller(async () => Response.json({ state: state(), sources: [] }))
    await value.show(sessionId)
    mount(value)
    for (const name of ['合成第1—2天', '合成第3—4天', '合成组包', '合成组', '合成处方头', '合成药味一', '未匹配合成药味', '合成诊疗工作', '合成护理工作', '未读关联路径']) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    }
    expect(screen.getAllByText(/0 合成单位/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(zh.unknown).length).toBeGreaterThan(0)
    expect(screen.getAllByText(zh.emptyCollection).length).toBeGreaterThan(0)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getAllByText(zh.admissionDay)).toHaveLength(2)
    expect(screen.getByText(zh.emrUnavailable)).toBeTruthy()
    expect(screen.getByText('合成使用科室', { selector: 'button' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.objects), { target: { value: 'herb-b' } })
    const selection = within(screen.getByRole('complementary'))
    expect(selection.getByText(zh.locked)).toBeTruthy()
    expect(selection.getByText('drugCode: 药味未匹配')).toBeTruthy()
    expect(selection.getByText(/source-fragment/)).toBeTruthy()
    expect(selection.getByText(/herb-b/)).toBeTruthy()
  })

  it('shows inclusion, exclusion and unknown admission criteria explicitly', async () => {
    const saved = state()
    const latest = saved.revisions.at(-1)
    if (latest === undefined) throw new Error('Fixture lacks a revision')
    latest.definition.clinicalPathway.inclusionAssessment = [
      { localId: 'include', inclusionItem: '纳入条件', isInclude: true, required: true },
      { localId: 'exclude', inclusionItem: '排除条件', isInclude: false, required: false },
      { localId: 'unknown-admission', inclusionItem: '未核条件', isInclude: null, required: null },
    ]
    const value = controller(async () => Response.json({ state: saved, sources: [] }))
    await value.show(sessionId)
    mount(value)
    for (const label of [zh.inclusion, zh.exclusion, zh.unknown]) {
      expect(screen.getByText(`${zh.admissionType}: ${label}`)).toBeTruthy()
    }
  })

  it('shows field and inherited locks using the host lock notation', async () => {
    const saved = state()
    const latest = saved.revisions.at(-1)
    if (latest === undefined) throw new Error('Fixture lacks a revision')
    latest.locks = ['order-b#onceDose', 'group', 'phase-a#orderTreatmentProjects']
    const value = controller(async () => Response.json({ state: saved, sources: [] }))
    await value.show(sessionId)
    mount(value)
    fireEvent.change(screen.getByLabelText(zh.objects), { target: { value: 'order-b' } })
    const selection = within(screen.getByRole('complementary'))
    expect(selection.getByText('字段锁：onceDose')).toBeTruthy()
    expect(selection.getByText('继承锁：group')).toBeTruthy()
    expect(selection.getByText('继承锁：phase-a#orderTreatmentProjects')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.objects), { target: { value: 'order-a' } })
    expect(selection.getByText('继承锁：group')).toBeTruthy()
    expect(selection.getByText(zh.locked)).toBeTruthy()
  })

  it('retains changed codes in the before/after difference when display names are equal', async () => {
    const saved = state()
    const latest = saved.revisions.at(-1)
    if (latest === undefined || saved.baseline === null) throw new Error('Fixture lacks a baseline')
    const before = identifiedObjects(saved.baseline).get('order-a')
    const after = identifiedObjects(latest.definition).get('order-a')
    if (before === undefined || after === undefined) throw new Error('Fixture lacks the selected object')
    before.usage = { code: 'ROUTE-A', name: '同名用法' }
    after.usage = { code: 'ROUTE-B', name: '同名用法' }
    const value = controller(async () => Response.json({ state: saved, sources: [] }))
    await value.show(sessionId)
    mount(value)
    fireEvent.change(screen.getByLabelText(zh.objects), { target: { value: 'order-a' } })
    const selection = within(screen.getByRole('complementary'))
    expect(selection.getByText(/ROUTE-A/)).toBeTruthy()
    expect(selection.getByText(/ROUTE-B/)).toBeTruthy()
  })

  it('uses stable selection for same-name objects and shows saved history with baseline differences', async () => {
    const value = controller(async () => Response.json({ state: state(), sources: [] }))
    await value.show(sessionId)
    mount(value)
    fireEvent.change(screen.getByLabelText(zh.objects), { target: { value: 'order-b' } })
    expect(within(screen.getByRole('complementary')).getByText(/order-b/)).toBeTruthy()
    expect(within(screen.getByRole('complementary')).queryByText(/order-a/)).toBeNull()
    fireEvent.change(screen.getByLabelText(zh.objects), { target: { value: 'pathway' } })
    expect(within(screen.getByRole('complementary')).getByText('合成参考路径', { exact: false })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.referenceRevision), { target: { value: '1' } })
    expect(screen.getByText(zh.historical)).toBeTruthy()
    expect(screen.getByText('合成参考路径', { selector: 'button' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.referenceRevision), { target: { value: '2' } })
    expect(screen.getByText(zh.current)).toBeTruthy()
  })

  it('restores the committed reference on reopen and retains it visibly after a refresh failure', async () => {
    let failed = false
    const value = controller(async () => failed ? new Response('', { status: 503 }) : Response.json({ state: state(), sources: [] }))
    await value.show(sessionId)
    mount(value)
    expect(screen.getByText('合成讨论任务')).toBeTruthy()
    failed = true
    await act(async () => { await value.refresh() })
    expect(screen.getByText(zh.readFailed)).toBeTruthy()
    expect(screen.getByText('合成讨论任务')).toBeTruthy()
    act(() => { value.close() })
    failed = false
    await act(async () => { await value.show(sessionId) })
    expect(screen.getByText('合成讨论任务')).toBeTruthy()
    expect(screen.queryByText(zh.readFailed)).toBeNull()
  })

  it('ignores late requests after switching Session, closing, or disposing even when transport ignores cancellation', async () => {
    const a = deferred<Response>(), b = deferred<Response>()
    let requests = 0
    const value = controller(async (_url, init) => {
      expect(init?.credentials).toBe('same-origin')
      expect(init?.cache).toBe('no-store')
      return ++requests === 1 ? a.promise : b.promise
    })
    const first = value.show(sessionId)
    const other = SessionId('another-session')
    const second = value.show(other)
    b.resolve(Response.json({ state: null, sources: [] }))
    await second
    a.resolve(Response.json({ state: state(), sources: [] }))
    await first
    expect(value.view.getSnapshot().sessionId).toBe(other)
    expect(value.view.getSnapshot().value?.state).toBeNull()
    const pending = deferred<Response>()
    const late = controller(async () => pending.promise)
    const read = late.show(sessionId)
    late.close(); late.dispose()
    pending.resolve(Response.json({ state: state(), sources: [] }))
    await read
    expect(late.view.getSnapshot()).toMatchObject({ open: false, value: null, busy: false })
  })

  it('removes retained reference content when Session access is denied', async () => {
    let denied = false
    const value = controller(async () => denied ? new Response('', { status: 403 }) : Response.json({ state: state(), sources: [] }))
    await value.show(sessionId)
    mount(value)
    expect(screen.getByText('合成讨论任务')).toBeTruthy()
    denied = true
    await act(async () => { await value.refresh() })
    expect(screen.getByText(zh.denied)).toBeTruthy()
    expect(screen.queryByText('合成讨论任务')).toBeNull()
    expect(screen.queryByText('source-fragment')).toBeNull()
  })

  it('follows revision metadata without a duplicate read when a pending response already covers it', async () => {
    const createResponse = deferred<Response>()
    const requests: { url: string; signal: AbortSignal | null }[] = []
    const value = controller(async (url, init) => {
      if (typeof url !== 'string') throw new Error('Expected API address')
      requests.push({ url, signal: init?.signal ?? null })
      return url.endsWith('/create') ? createResponse.promise : Response.json({ state: null, sources: [] })
    })
    await value.show(sessionId)
    const creating = value.create('new', '新参考任务')
    value.observeRevision(sessionId, 2)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.signal?.aborted).toBe(false)
    createResponse.resolve(Response.json({ state: state(), sources: [] }))
    await creating
    expect(value.view.getSnapshot().value?.state?.revisions.at(-1)?.revision).toBe(2)
    expect(requests).toHaveLength(2)
  })

  it('queues one newer read after an older pending response and ignores other Session notifications', async () => {
    const initial = deferred<Response>()
    let reads = 0
    const value = controller(async () => ++reads === 1 ? initial.promise : Response.json({ state: state(), sources: [] }))
    const opening = value.show(sessionId)
    value.observeRevision(SessionId('other-session'), 99)
    value.observeRevision(sessionId, 2)
    expect(reads).toBe(1)
    initial.resolve(Response.json({ state: null, sources: [] }))
    await opening
    await waitFor(() => { expect(value.view.getSnapshot().value?.state?.revisions.at(-1)?.revision).toBe(2) })
    expect(reads).toBe(2)
    value.observeRevision(sessionId, 2)
    expect(reads).toBe(2)
  })

  it('retains content after an automatic read failure without retrying the same advertised revision forever', async () => {
    let reads = 0
    const value = controller(async () => ++reads === 1 ? Response.json({ state: state(), sources: [] }) : new Response('', { status: 503 }))
    await value.show(sessionId)
    value.observeRevision(sessionId, 3)
    await waitFor(() => { expect(value.view.getSnapshot().issue).toBe('readFailed') })
    expect(value.view.getSnapshot().value?.state?.title).toBe('合成讨论任务')
    value.observeRevision(sessionId, 3)
    expect(reads).toBe(2)
    value.observeRevision(sessionId, 4)
    await waitFor(() => { expect(value.view.getSnapshot().busy).toBe(false) })
    expect(reads).toBe(3)
  })

  it('reconciles an uncertain create before retry and keeps the same request identity', async () => {
    const requests: Record<string, unknown>[] = []
    let failedRead = false, created = false
    const value = controller(async (url, init) => {
      if (typeof url === 'string' && url.endsWith('/create')) {
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
        if (body !== null && typeof body === 'object') requests.push(body as Record<string, unknown>)
        if (!created) { created = true; throw new Error('Connection lost after submission') }
        return Response.json({ state: state(), sources: [] })
      }
      if (failedRead) throw new Error('Offline')
      return Response.json({ state: null, sources: [] })
    })
    await value.show(sessionId)
    await value.create('new', '合成任务')
    expect(value.view.getSnapshot()).toMatchObject({ issue: 'createUnconfirmed', creationUnconfirmed: true })
    failedRead = true
    await value.refresh()
    await value.create('new', '合成任务')
    expect(requests).toHaveLength(1)
    failedRead = false
    await value.refresh()
    await value.create('new', '合成任务')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.requestId).toBe(requests[1]?.requestId)
    expect(requests[1]?.scope).toEqual(config.scope)
  })
})
