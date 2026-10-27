/** Real gateway, policy, fixed queries and HTTP; only the PostgreSQL driver is replaced. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PgReadDatabase } from '@deepseek-ai/dsh-experimental-emr-reader-broker'
import type { HostedRuntimeActor, HostedRuntimeRequest } from '@deepseek-ai/dsh-experimental-hosted-workspaces'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { Config } from '../src/config.ts'
import { PathwayGateway } from '../src/gateway.ts'
import * as Reader from '../src/index.ts'
import { PathwayPolicy } from '../src/policy.ts'
import { resultSchema } from '../src/protocol.ts'

interface SqlCall { sql: string; values: readonly (string | number)[] }
interface Driver {
  connected: number
  closed: number
  onClose: (() => void) | undefined
  query(sql: string, values: readonly (string | number)[]): Promise<readonly unknown[]>
}
const drivers = vi.hoisted(() => new Map<string, Driver>())
vi.mock('pg', () => ({ default: { Client: class {
  private readonly driver: Driver
  private closed = false
  constructor(config: { database: string }) {
    const driver = drivers.get(config.database)
    if (driver === undefined) throw new Error('No synthetic database registered')
    this.driver = driver
  }
  on() { return this }
  off() { return this }
  async connect() { this.driver.connected++ }
  async end() {
    if (this.closed) return
    this.closed = true
    this.driver.closed++
    this.driver.onClose?.()
  }
  async query(sql: string, values: readonly (string | number)[] = []) {
    return { rows: await this.driver.query(sql, values) }
  }
} } }))

const actor: HostedRuntimeActor = {
  id: brandString<HostedRuntimeActor['id']>('synthetic-account'), issuer: 'https://identity.test', subject: 'reader-one',
}
const grant = {
  issuer: actor.issuer, subject: actor.subject, sourceSystem: 'synthetic-clinical', hospitalCode: 'hospital-one',
  departmentCodes: ['department-one', 'department-two'], departmentBasis: 'discharge',
  admissionFrom: '2025-01-01T00:00:00Z', admissionTo: '2026-01-01T00:00:00Z',
}
const history = { from: '2025-04-01T00:00:00Z', to: '2025-05-01T00:00:00Z', timeBasis: 'admission' }
const countKeys = ['admissionCount', 'executionCount', 'admissionsWithoutExecutionCount', 'notIncludedCount', 'underwayCount',
  'exitCount', 'systemMarkedCompleteCount', 'offPathwayTreatmentCount', 'unknownExecutionStatusCount',
  'unknownExecutionDeletedFlagCount', 'unknownTreatmentPackageFlagCount', 'currentReasonCount',
  'reasonVariationTrueCount', 'reasonVariationFalseCount', 'reasonVariationUnknownCount', 'executionsWithoutRetainedReasonCount']

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(overrides: Partial<Config> = {}, useLoader = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pathway-gateway-'))
  const ctx = new Context()
  const pending = new Set<Promise<void>>()
  const releases: (() => void)[] = []
  const requestAbort = new AbortController()
  const state = { active: true, actor, beforeBusiness: undefined as (() => Promise<void>) | undefined,
    beforeServe: undefined as ((response: ServerResponse) => Promise<void>) | undefined,
    pathwayName: '合成路径', sourceFailure: false, unsafeRole: false, loginFailure: false }
  const calls: SqlCall[] = []
  const businessCalls: SqlCall[] = []
  const driver: Driver = {
    connected: 0, closed: 0, onClose: undefined,
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql.startsWith('SELECT set_config')) return [{ set_config: values[0] }]
      if (sql.includes('current_schema()')) return [{ schema: 'public', read_only: 'on', time_zone: 'UTC', has_temp_schema: false,
        unsafe_role: state.unsafeRole }]
      if (sql.includes('has_table_privilege')) {
        const tables = z.array(z.string()).parse(JSON.parse(String(values[1])))
        return tables.map(table_name => ({ table_name, readable: true, writable: false, owned: false, schema_owned: false }))
      }
      if (!sql.startsWith('WITH dsh_source AS')) return []
      businessCalls.push({ sql, values })
      await state.beforeBusiness?.()
      if (state.sourceFailure) throw new Error('synthetic-private-driver-detail')
      if (sql.includes('pathway:definitions')) return [{ data: { id: '1', pathway_name: state.pathwayName, version_no: '1' } }]
      if (sql.includes('history:summary')) return [{ data: Object.fromEntries(countKeys.map(key => [key, 0])) }]
      if (sql.includes('FROM cpoe_inpat_record p')) return [{ data: { inpatId: '100', inpatCode: 'synthetic-visit',
        hospitalCode: grant.hospitalCode, stateCode: '4' } }]
      return []
    },
  }
  const databaseConfig = { host: 'synthetic.invalid', port: 5432, database: directory, user: 'readonly', password: 'synthetic-only' }
  const config = Config({ mode: 'gateway', sourceSystem: grant.sourceSystem,
    databaseConfigFile: join(directory, 'database.json'), policyFile: join(directory, 'policy.json'), ...overrides })
  const policy = new PathwayPolicy(config.policyFile!, config.maxPolicyBytes, grant.sourceSystem)
  const gateway = new PathwayGateway(config, grant.sourceSystem, new PgReadDatabase(databaseConfig, config.timeoutMs), policy)
  drivers.set(directory, driver)
  const serve = (request: HostedRuntimeRequest) => useLoader
    ? ctx.waterfall('hosted-workspaces/runtime-request', request, async () => false) : gateway.handle(request)
  const server = createServer((request, response) => {
    const disconnected = new AbortController()
    request.once('aborted', () => { disconnected.abort() })
    response.once('close', () => { if (!response.writableEnded) disconnected.abort() })
    const work = (async () => {
      await state.beforeServe?.(response)
      return serve({ actor: state.actor, request, response,
        signal: AbortSignal.any([requestAbort.signal, disconnected.signal]), isActive: () => {
          if (state.loginFailure) throw new Error('synthetic-private-login-detail')
          return state.active
        } })
    })()
      .then((handled) => { if (!handled) { response.writeHead(404); response.end('unhandled') } })
      .catch(() => { if (!response.destroyed && !response.writableEnded) { response.writeHead(500); response.end('fixture failure') } })
    pending.add(work)
    void work.finally(() => pending.delete(work))
  })
  onTestFinished(async () => {
    for (const release of releases) release()
    requestAbort.abort()
    await gateway.dispose()
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await Promise.allSettled(pending)
    drivers.delete(directory)
    await rm(directory, { recursive: true, force: true })
  })
  const saveGrants = async (grants: unknown[]) => writeFile(config.policyFile!, JSON.stringify({ schemaVersion: 1, grants }))
  await writeFile(config.databaseConfigFile!, JSON.stringify(databaseConfig))
  await saveGrants([grant])
  if (useLoader) {
    const file = join(directory, 'cordis.yml')
    await writeFile(file, `- name: cordis:pathway-reader\n  config: ${JSON.stringify(config)}\n`)
    ctx.baseUrl = `${pathToFileURL(directory).href}/`
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, 'pathway-reader': Reader })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  } else await gateway.validate()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture TCP bind failed')
  const url = `http://127.0.0.1:${address.port}`
  const call = (tool: string, body: object, options: RequestInit = {}) => fetch(`${url}/runtime/clinical-pathway/${tool}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options,
  })
  const hold = () => {
    const entered = barrier(), released = barrier(), closed = barrier()
    releases.push(released.resolve)
    driver.onClose = closed.resolve
    state.beforeBusiness = async () => { entered.resolve(); await released.promise }
    return { entered: entered.promise, closed: closed.promise, release: released.resolve }
  }
  const holdDispatch = () => {
    const entered = barrier(), released = barrier(), closed = barrier()
    releases.push(released.resolve)
    state.beforeServe = async (response) => {
      response.once('close', closed.resolve)
      entered.resolve()
      await released.promise
    }
    return { entered: entered.promise, closed: closed.promise, release: released.resolve }
  }
  return { config, gateway, ctx, driver, calls, businessCalls, state, call, saveGrants, requestAbort, hold, holdDispatch, pending }
}

it('loads the production gateway, serves its HTTP runtime event and unregisters on disposal', async () => {
  const world = await fixture({}, true)
  const response = await world.call('pathway_read', { departmentCodes: ['department-two'] })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const result = resultSchema.parse(await response.json())
  expect(result).toMatchObject({ tool: 'pathway_read', sourceSystem: grant.sourceSystem,
    scope: { hospitalCode: grant.hospitalCode, departmentCodes: ['department-two'], includeSharedDefinitions: false },
    collections: { pathways: [{ id: '1', pathway_name: '合成路径' }] } })
  expect(result.readStartedAt <= result.readCompletedAt).toBe(true)
  expect(world.calls.filter(call => call.sql.includes('current_schema()'))).toHaveLength(2)
  expect(world.calls.some(call => call.sql === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')).toBe(true)
  expect(world.driver.closed).toBe(world.driver.connected)
  expect((await world.call('unrelated', {})).status).toBe(404)
  const entry = [...world.ctx.loader.entries()].find(value => value.options.name === 'cordis:pathway-reader')
  if (!entry?.fiber) throw new Error('Missing pathway reader fiber')
  await entry.fiber.dispose()
  expect((await world.call('pathway_read', {})).status).toBe(404)
})

it('binds the independent admission grant separately from narrower historical time filters', async () => {
  const world = await fixture()
  const response = await world.call('history_query', { ...history, departmentCodes: ['department-two'] })
  expect(response.status).toBe(200)
  const result = resultSchema.parse(await response.json())
  expect(result.scope).toMatchObject({ departmentBasis: 'discharge', admissionFrom: grant.admissionFrom, admissionTo: grant.admissionTo })
  expect(result.filters).toMatchObject(history)
  expect(result.measures.admissionCount).toBe(0)
  const query = world.businessCalls[0]!
  expect(query.values.slice(0, 7)).toEqual([grant.hospitalCode, '["department-two"]', grant.admissionFrom,
    grant.admissionTo, history.from, history.to, history.timeBasis])
  expect(query.sql).toContain('p.out_dept_code IN')
  expect(query.sql).toContain('p.in_time >= $3::timestamptz AND p.in_time < $4::timestamptz')
  expect((await world.call('case_read', { inpatId: '100', category: 'encounter' })).status).toBe(200)
})

it.each([
  { tool: 'pathway_read', body: { actor: { subject: 'reader-one' } }, status: 400 },
  { tool: 'pathway_read', body: { sql: 'SELECT synthetic' }, status: 400 },
  { tool: 'pathway_read', body: { readRolePolicy: 'development-transaction-only' }, status: 400 },
  { tool: 'pathway_read', body: { allowWritableDevelopmentRole: true }, status: 400 },
  { tool: 'pathway_read', body: { admissionFrom: '2000-01-01T00:00:00Z' }, status: 400 },
  { tool: 'history_query', body: { ...history, actor: { subject: 'reader-one' } }, status: 400 },
  { tool: 'case_read', body: { inpatId: '100', category: 'encounter', sql: 'SELECT synthetic' }, status: 400 },
  { tool: 'pathway_read', body: { hospitalCode: 'other-hospital' }, status: 403 },
  { tool: 'pathway_read', body: { departmentCodes: ['outside-department'] }, status: 403 },
  { tool: 'history_query', body: { ...history, from: history.to }, status: 400 },
  { tool: 'history_query', body: { ...history, from: '2025-06-01T00:00:00Z' }, status: 400 },
  { tool: 'history_query', body: { ...history, from: '2025-01-01' }, status: 400 },
  { tool: 'case_read', body: { inpatId: '100', category: 'unrecognized' }, status: 400 },
])('rejects $tool arguments before opening a source transaction: $body', async ({ tool, body, status }) => {
  const world = await fixture()
  const connected = world.driver.connected
  const response = await world.call(tool, body)
  expect(response.status).toBe(status)
  expect(world.businessCalls).toHaveLength(0)
  expect(world.driver.connected).toBe(connected)
})

it('rejects inactive login, foreign identity and revoked policy before source reads', async () => {
  const world = await fixture()
  world.state.active = false
  expect((await world.call('pathway_read', {})).status).toBe(403)
  world.state.active = true
  world.state.actor = { ...actor, subject: 'other-account' }
  expect((await world.call('pathway_read', {})).status).toBe(403)
  world.state.actor = actor
  await world.saveGrants([])
  expect((await world.call('pathway_read', {})).status).toBe(403)
  expect(world.businessCalls).toHaveLength(0)
  expect(world.driver.connected).toBe(1)
})

it.each(['login', 'revoke', 'scope'])('withholds a completed read after %s changes in flight', async (change) => {
  const world = await fixture()
  const hold = world.hold()
  const pending = world.call('pathway_read', {})
  await hold.entered
  if (change === 'login') world.state.active = false
  else await world.saveGrants(change === 'revoke' ? [] : [{ ...grant, admissionTo: '2025-12-01T00:00:00Z' }])
  hold.release()
  const response = await pending
  expect(response.status).toBe(403)
  const body = await response.text()
  expect(body).toContain('forbidden')
  expect(body).not.toContain('合成路径')
  expect(body).not.toContain('collections')
})

it('bounds the complete UTF-8 response including scope, filters and coverage at the exact byte limit', async () => {
  const baseline = await fixture()
  baseline.state.pathwayName = '合成'.repeat(100)
  const first = await baseline.call('pathway_read', {})
  expect(first.status).toBe(200)
  const text = await first.text()
  const bytes = Buffer.byteLength(text)
  expect(bytes).toBeGreaterThan(text.length)
  for (const difference of [0, -1]) {
    const world = await fixture({ maxResponseBytes: bytes + difference })
    world.state.pathwayName = baseline.state.pathwayName
    const response = await world.call('pathway_read', {})
    expect(response.status).toBe(difference === 0 ? 200 : 413)
    const body = await response.text()
    if (difference === 0) expect(Buffer.byteLength(body)).toBe(bytes)
    else {
      expect(body).toContain('limit-exceeded')
      expect(body).not.toContain(world.state.pathwayName)
    }
  }
})

it('enforces request bytes and JSON media type before any database work', async () => {
  const world = await fixture({ maxRequestBytes: 32 })
  const connected = world.driver.connected
  expect((await world.call('pathway_read', { search: '合'.repeat(20) })).status).toBe(413)
  expect((await world.call('pathway_read', {}, { headers: { 'content-type': 'text/plain' } })).status).toBe(400)
  expect((await world.call('pathway_read', {}, { method: 'GET', body: null })).status).toBe(400)
  expect((await world.call('pathway_read', {}, { body: '' })).status).toBe(400)
  expect((await world.call('pathway_read', {}, { body: '{' })).status).toBe(400)
  expect(world.driver.connected).toBe(connected)
})

it('rejects concurrent excess work without acquiring another source connection', async () => {
  const world = await fixture({ maxConcurrentReads: 1 })
  const hold = world.hold()
  const first = world.call('pathway_read', {})
  await hold.entered
  const connected = world.driver.connected
  const excess = await world.call('pathway_read', {})
  expect(excess.status).toBe(429)
  expect(world.driver.connected).toBe(connected)
  hold.release()
  expect((await first).status).toBe(200)
  expect((await world.call('pathway_read', {})).status).toBe(200)
})

it('does not write an overload response after the waiting HTTP client disconnects', async () => {
  const world = await fixture({ maxConcurrentReads: 1 })
  const hold = world.hold()
  const first = world.call('pathway_read', {})
  await hold.entered
  const connected = world.driver.connected
  const dispatch = world.holdDispatch()
  const cancelled = new AbortController()
  const abandoned = world.call('pathway_read', {}, { signal: cancelled.signal }).catch((error: unknown) => error)
  await dispatch.entered
  cancelled.abort()
  await dispatch.closed
  dispatch.release()
  hold.release()
  expect((await first).status).toBe(200)
  expect(await abandoned).toMatchObject({ name: 'AbortError' })
  await Promise.allSettled(world.pending)
  expect(world.driver.connected).toBe(connected)
})

it.each(['request', 'dispose'])('cancels %s work and waits for its source read to settle before disposal', async (action) => {
  const world = await fixture()
  const hold = world.hold()
  const reading = world.call('pathway_read', {})
  await hold.entered
  let disposed = false
  if (action === 'request') {
    world.requestAbort.abort()
    await hold.closed
  }
  const disposing = world.gateway.dispose().then(() => { disposed = true })
  await hold.closed
  expect(disposed).toBe(false)
  hold.release()
  await disposing
  expect(disposed).toBe(true)
  const response = await reading
  expect(response.status).toBe(408)
  expect(await response.text()).not.toContain('合成路径')
  const connected = world.driver.connected
  expect((await world.call('pathway_read', {})).status).toBe(408)
  expect(world.driver.connected).toBe(connected)
  expect(world.driver.closed).toBe(world.driver.connected)
})

it('rechecks source privileges on each call and reports driver failures without private details', async () => {
  const world = await fixture()
  world.state.unsafeRole = true
  expect((await world.call('pathway_read', {})).status).toBe(503)
  expect(world.businessCalls).toHaveLength(0)
  world.state.unsafeRole = false
  world.state.sourceFailure = true
  const response = await world.call('pathway_read', {})
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('synthetic-private-driver-detail')
})

it('reports an unavailable login check without acquiring a source connection or leaking provider details', async () => {
  const world = await fixture()
  world.state.loginFailure = true
  const connected = world.driver.connected
  const response = await world.call('pathway_read', {})
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: { code: 'source-unavailable',
    message: 'Pathway data is unavailable. Check the read-only source configuration and retry.' } })
  expect(world.driver.connected).toBe(connected)
})

it('withholds source evidence when operator scope fields exceed the result wire limits', async () => {
  const world = await fixture()
  await world.saveGrants([{ ...grant, departmentCodes: ['x'.repeat(129)] }])
  const response = await world.call('pathway_read', {})
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: { code: 'source-unavailable',
    message: 'Pathway source fields are invalid. Check the configured source schema and reader.' } })
})
