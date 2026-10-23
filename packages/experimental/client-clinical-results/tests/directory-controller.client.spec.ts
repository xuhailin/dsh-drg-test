/** Directory selection remains explicit and stale patient admissions cannot replace the active view. */
import { describe, expect, it, vi } from 'vitest'
import { DirectoryController } from '../src/client/directory-controller.ts'
import type { ViewerConfig } from '../src/types.ts'

const config: ViewerConfig = { allowedOrigins: [], requestTimeoutMs: 1000, maxMessageBytes: 8192,
  maxPendingRequests: 4, maxActionReceipts: 20, directoryPageSize: 20 }
const department = { sourceSystem: 'fixture', hospitalCode: '1001', departmentCode: 'dept-one', departmentName: 'Fixture department' }
const patient = { inpatId: '123', patientName: 'Synthetic patient', bedName: 'B1' }
const page = { sourceSystem: 'fixture', hospitalCode: '1001', departmentCode: 'dept-one', pageIndex: 1, pageSize: 20, hasMore: false, patients: [patient] }

function bench(send: typeof fetch) {
  const clear = vi.fn(), open = vi.fn(async () => {})
  const controller = new DirectoryController(config, send, clear, open)
  return { controller, clear, open }
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body.')
  const value: unknown = JSON.parse(init.body)
  return value
}

describe('patient directory controller', () => {
  it('browses then binds a selected patient without requesting a review', async () => {
    const requests: { url: string; body: unknown }[] = []
    const test = bench(async (url, init) => {
      requests.push({ url: requestUrl(url), body: requestBody(init) })
      return Response.json(requestUrl(url).endsWith('/departments') ? { departments: [department] } : requestUrl(url).endsWith('/patients') ? page
        : { sessionId: 'clinical-fixture', revision: 0, status: 'bound', dischargeBlocked: false })
    })
    await test.controller.load()
    expect(requests).toHaveLength(1)
    expect(test.controller.view.getSnapshot().page).toBeNull()
    await test.controller.choose(department)
    await test.controller.open(patient, department)
    expect(requests.map(item => item.url)).toEqual(['api/clinical-review/departments', 'api/clinical-review/patients', 'api/clinical-review/launch'])
    expect(requests[2]!.body).toMatchObject({ trigger: 'open', inpatId: '123', hospitalCode: '1001' })
    expect(test.open).toHaveBeenCalledExactlyOnceWith({ sessionId: 'clinical-fixture' })
    expect(test.clear).toHaveBeenCalled()
    test.controller.dispose()
  })

  it('rejects mismatched directory scopes and clears data on revoked permission', async () => {
    let denied = false
    const test = bench(async url => requestUrl(url).endsWith('/departments') ? Response.json({ departments: [department] })
      : denied ? new Response(null, { status: 403 }) : Response.json({ ...page, hospitalCode: 'forged' }))
    await test.controller.load()
    await test.controller.choose(department)
    expect(test.controller.view.getSnapshot().phase).toBe('failed')
    expect(test.controller.view.getSnapshot().page).toBeNull()
    denied = true
    await test.controller.page(1)
    expect(test.controller.view.getSnapshot()).toMatchObject({ phase: 'denied', department: null, departments: [], selectedPatient: null, sessionId: null })
    test.controller.dispose()
  })

  it('ignores a late launch after changing departments', async () => {
    let settle: ((response: Response) => void) | undefined
    const test = bench(async url => requestUrl(url).endsWith('/departments') ? Response.json({ departments: [department] })
      : requestUrl(url).endsWith('/patients') ? Response.json(page) : new Promise((resolve) => { settle = resolve }))
    await test.controller.load()
    await test.controller.choose(department)
    const pending = test.controller.open(patient, department)
    await test.controller.choose(department)
    settle!(Response.json({ sessionId: 'old-patient', revision: 0, status: 'bound', dischargeBlocked: false }))
    await pending
    expect(test.open).not.toHaveBeenCalled()
    expect(test.controller.view.getSnapshot().sessionId).toBeNull()
    test.controller.dispose()
  })
  it('clears patient content when the refreshed grant listing removes its department', async () => {
    let removed = false
    const test = bench(async url => requestUrl(url).endsWith('/departments') ? Response.json({ departments: removed ? [] : [department] })
      : requestUrl(url).endsWith('/patients') ? Response.json(page) : Response.json({ sessionId: 'clinical-fixture', revision: 0, status: 'bound', dischargeBlocked: false }))
    await test.controller.load(); await test.controller.choose(department); await test.controller.open(patient, department)
    removed = true
    await test.controller.load()
    expect(test.controller.view.getSnapshot()).toMatchObject({ department: null, page: null, selectedPatient: null, sessionId: null })
    expect(test.clear).toHaveBeenCalledTimes(3)
    await test.controller.choose(department)
    expect(test.controller.view.getSnapshot().department).toBeNull()
    test.controller.dispose()
  })

  it('does not resolve a click by the position of a replacement patient row', async () => {
    const test = bench(async url => requestUrl(url).endsWith('/departments') ? Response.json({ departments: [department] }) : Response.json(page))
    await test.controller.load(); await test.controller.choose(department)
    test.controller.view.update((state) => { if (state.page !== null) state.page.patients = [{ ...patient, inpatId: '456' }] })
    await test.controller.open(patient, department)
    expect(test.open).not.toHaveBeenCalled()
    expect(test.controller.view.getSnapshot().sessionId).toBeNull()
    test.controller.dispose()
  })

})
