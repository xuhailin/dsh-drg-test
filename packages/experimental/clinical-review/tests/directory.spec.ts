/** Browser directory requests stay owner-authenticated and reject identity overrides before forwarding. */
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { registerClinicalDirectory } from '../src/directory.ts'
import type { BrokerAccess } from '../src/reader.ts'

function fixture(maxRequestBytes = 65536) {
  const ctx = new Context()
  onTestFinished(async () => ctx.fiber.dispose())
  const routes = new Map<string, ConnectionFetchRoute>()
  ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
    routes.set(route.path, route)
    return ctx.effect(() => async () => { routes.delete(route.path) })
  } } })
  const access = {
    departments: vi.fn<BrokerAccess['departments']>().mockResolvedValue({ departments: [] }),
    patients: vi.fn<BrokerAccess['patients']>().mockResolvedValue({ sourceSystem: 'fixture', hospitalCode: '1001', departmentCode: 'd1', pageIndex: 1, pageSize: 20, hasMore: false, patients: [] }),
  }
  const config = Config({ brokerBaseUrl: 'https://gateway.example/runtime/emr/', runtimeTokenEnv: 'TEST_TOKEN', ownerId: 'owner', cwd: '/tmp', maxRequestBytes })
  registerClinicalDirectory(ctx, config, access)
  const call = async (name: string, body: object) => {
    const route = routes.get(`/api/clinical-review/${name}`)
    if (route === undefined) throw new Error('Missing directory route')
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('buffered')
    return route.fetch(new Request(`https://workspace.example/api/clinical-review/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  }
  return { ctx, routes, access, call }
}
const request = { sourceSystem: 'fixture', hospitalCode: '1001', departmentCode: 'd1', pageIndex: 1, pageSize: 20 }
describe('clinical directory browser bridge', () => {
  it('forwards exact selectors and removes routes on scope disposal', async () => {
    const world = fixture()
    expect((await world.call('departments', {})).status).toBe(200)
    const response = await world.call('patients', request)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(world.access.patients).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    await world.ctx.fiber.dispose()
    expect(world.routes.size).toBe(0)
  })
  it('rejects arbitrary identity fields and oversized requests before forwarding', async () => {
    const world = fixture(300)
    expect((await world.call('departments', { subject: 'other-account' })).status).toBe(400)
    expect((await world.call('patients', { ...request, actorId: 'other-account' })).status).toBe(400)
    expect((await world.call('patients', { ...request, search: 'x'.repeat(400) })).status).toBe(413)
    expect(world.access.departments).not.toHaveBeenCalled()
    expect(world.access.patients).not.toHaveBeenCalled()
  })
  it('preserves typed denials and redacts unexpected broker diagnostics', async () => {
    const world = fixture()
    world.access.patients.mockRejectedValueOnce(new EncounterReadError('forbidden', 'Reload your authorized department list.'))
      .mockRejectedValueOnce(new Error('private database diagnostic'))
    expect((await world.call('patients', request)).status).toBe(403)
    const unavailable = await world.call('patients', request)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.text()).not.toContain('private database diagnostic')
  })
})
