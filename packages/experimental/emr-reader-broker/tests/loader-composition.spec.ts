/** Real Loader and HTTP runtime event; PostgreSQL is the only external fixture. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseBinding, parseLaunchGrantResult, parseSnapshot } from '@deepseek-ai/dsh-experimental-emr-encounter'
import type { HostedRuntimeRequest } from '@deepseek-ai/dsh-experimental-hosted-workspaces'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as Broker from '../src/index.ts'

const database = vi.hoisted(() => ({ statements: [] as string[], closed: 0, department: 'dept-one' }))
vi.mock('pg', () => ({ default: { Client: class {
  on() { return this }
  off() { return this }
  async connect() {}
  async end() { database.closed++ }
  async query(sql: string) {
    database.statements.push(sql)
    if (sql.startsWith('WITH authorized')) return { rows: [{ hospital_code: '1001', department_code: 'dept-one', department_name: 'Synthetic Department' }] }
    if (sql.startsWith('SELECT r.inpat_id::text AS inpat_id')) return { rows: [{ inpat_id: '100', inpat_code: 'visit-100', patient_name: 'Synthetic Patient', bed_name: '1' }] }
    if (sql.startsWith('SELECT inpat_id')) return { rows: [{ id: '100', inpat_code: 'visit-100', current_dept_code: database.department, inpat_state_code: '4' }] }
    if (!sql.startsWith('WITH evidence')) return { rows: [] }
    return { rows: [{ id: '1', state: 'recorded', occurred_at: null, available_at: null, oversized: false, body: { text: 'Synthetic case evidence.' } }] }
  }
} } }))

describe('clinical broker Loader composition', () => {
  it('authorizes one-use launch, captures evidence, rejects foreign bindings and unregisters on disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-clinical-loader-'))
    const ctx = new Context()
    const actor: HostedRuntimeRequest['actor'] = { id: brandString<HostedRuntimeRequest['actor']['id']>('account-one'), issuer: 'https://sso.test', subject: 'doctor-one' }
    let active = true
    const server = createServer((request, response) => {
      void ctx.waterfall('hosted-workspaces/runtime-request', { actor, request, response, signal: new AbortController().signal, isActive: () => active }, async () => false)
        .then((handled) => { if (!handled) { response.writeHead(404); response.end('unhandled') } })
        .catch(() => { response.writeHead(500); response.end('fixture failure') })
    })
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() =>{  resolve() }))
      await rm(root, { recursive: true, force: true })
    })
    const config = {
      sourceSystem: 'fixture-emr', databaseConfigFile: join(root, 'database.json'), allowlistFile: join(root, 'allowlist.json'), bindingKeyFile: join(root, 'binding-key'),
    }
    await writeFile(config.databaseConfigFile, JSON.stringify({ host: 'fixture.invalid', port: 5432, database: 'fixture', user: 'readonly', password: 'synthetic-test-only' }))
    await writeFile(config.allowlistFile, JSON.stringify({ schemaVersion: 1, entries: [{ issuer: actor.issuer, subject: actor.subject, sourceSystem: 'fixture-emr', hospitalCode: '1001', inpatId: '100', inpatCode: 'visit-100' }] }))
    await writeFile(config.bindingKeyFile, 'synthetic-binding-secret-at-least-32-characters')
    const file = join(root, 'cordis.yml')
    await writeFile(file, `- name: cordis:clinical-broker\n  config: ${JSON.stringify(config)}\n`)
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, 'clinical-broker': Broker })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture TCP bind failed')
    const call = async (path: string, body: object) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const launch = await call('/runtime/emr/launch', { eventId: 'one', trigger: 'manual-review', sourceSystem: 'fixture-emr', hospitalCode: '1001', inpatId: '100', inpatCode: 'visit-100' })
    expect(launch.status).toBe(200)
    const { grant } = parseLaunchGrantResult(await launch.json())
    const consumed = await call('/runtime/emr/consume', { grant })
    expect(consumed.status).toBe(200)
    const binding = parseBinding(await consumed.json())
    expect(binding.actorId).toBe(actor.id)
    expect((await call('/runtime/emr/consume', { grant })).status).toBe(410)
    const statements = database.statements.length
    const authorized = await call('/runtime/emr/authorize', { binding })
    expect(authorized.status).toBe(200)
    expect(parseBinding(await authorized.json())).toEqual(binding)
    expect(database.statements).toHaveLength(statements)
    expect((await call('/runtime/emr/authorize', { binding: { ...binding, inpatId: '101' } })).status).toBe(403)
    const captured = await call('/runtime/emr/capture', { binding })
    expect(captured.status).toBe(200)
    const snapshot = parseSnapshot(await captured.json())
    expect(snapshot.sources).toHaveLength(4)
    expect(snapshot.coverage.find(item => item.category === 'administration')?.status).toBe('unsupported')
    expect(database.statements).toContain('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(database.closed).toBeGreaterThanOrEqual(2)
    expect((await call('/runtime/emr/capture', { binding: { ...binding, inpatId: '101' } })).status).toBe(403)
    await writeFile(config.allowlistFile, JSON.stringify({ schemaVersion: 1, entries: [], departments: [{ issuer: actor.issuer, subject: actor.subject, sourceSystem: 'fixture-emr', hospitalCode: '1001', departmentCode: 'dept-one' }] }))
    const departments = await call('/runtime/emr/departments', {})
    expect(departments.status).toBe(200)
    expect(await departments.json()).toEqual({ departments: [{ sourceSystem: 'fixture-emr', hospitalCode: '1001', departmentCode: 'dept-one', departmentName: 'Synthetic Department' }] })
    const patientRequest = { sourceSystem: 'fixture-emr', hospitalCode: '1001', departmentCode: 'dept-one', pageIndex: 1, pageSize: 10 }
    const patients = await call('/runtime/emr/patients', patientRequest)
    expect(patients.status).toBe(200)
    expect(await patients.json()).toMatchObject({ patients: [{ inpatId: '100', patientName: 'Synthetic Patient' }], hasMore: false })
    expect((await call('/runtime/emr/patients', { ...patientRequest, hospitalCode: 'other' })).status).toBe(403)
    expect((await call('/runtime/emr/authorize', { binding })).status).toBe(200)
    database.department = 'other-department'
    expect((await call('/runtime/emr/authorize', { binding })).status).toBe(403)
    expect((await call('/runtime/emr/capture', { binding })).status).toBe(403)
    database.department = 'dept-one'
    active = false
    expect((await call('/runtime/emr/authorize', { binding })).status).toBe(403)
    expect((await call('/runtime/emr/capture', { binding })).status).toBe(403)
    active = true
    await writeFile(config.allowlistFile, JSON.stringify({ schemaVersion: 1, entries: [] }))
    expect((await call('/runtime/emr/authorize', { binding })).status).toBe(403)
    expect((await call('/runtime/unrelated', {})).status).toBe(404)
    const entry = [...ctx.loader.entries()].find(item => item.options.name === 'cordis:clinical-broker')
    if (!entry?.fiber) throw new Error('Missing broker fiber')
    await entry.fiber.dispose()
    expect((await call('/runtime/emr/capture', { binding })).status).toBe(404)
    expect(ctx.get('encounterReader')).toBeUndefined()
  })
})
