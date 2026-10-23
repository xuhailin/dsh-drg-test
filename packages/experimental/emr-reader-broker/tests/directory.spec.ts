/** Synthetic policies exercise source authorization independently of browser filtering. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { patientDirectoryRequestSchema, type ClinicalActor, type LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Config } from '../src/config.ts'
import type { ReadDatabase, ReadTransaction } from '../src/database.ts'
import { departmentsSql, patientsSql, PgEncounterDirectory } from '../src/directory.ts'
import { EncounterPolicy } from '../src/policy.ts'
import { PgEncounterReader } from '../src/reader.ts'
import { encounterIdentitySql, sourceQueries } from '../src/sql.ts'

const actor: ClinicalActor = { id: 'account-one', issuer: 'https://sso.test', subject: 'doctor-one' }
const scope = { sourceSystem: 'fixture-emr', hospitalCode: '1001', departmentCode: 'dept-one' }
const claim: LaunchClaim = { eventId: 'event-one', trigger: 'open', sourceSystem: scope.sourceSystem, hospitalCode: scope.hospitalCode, inpatId: '101', inpatCode: 'visit-101' }
const grant = { issuer: actor.issuer, subject: actor.subject, ...scope }
const request = { ...scope, pageIndex: 1, pageSize: 2 }

async function fixture(overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-emr-directory-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const path = join(root, 'policy.json')
  const save = async (departments: readonly typeof grant[] = [grant]) => writeFile(path,
    JSON.stringify({ schemaVersion: 1, entries: [], departments }))
  await save()
  const config = Config({ sourceSystem: scope.sourceSystem, allowlistFile: path, databaseConfigFile: '/fixture/db', bindingKeyFile: '/fixture/key', ...overrides })
  const policy = new EncounterPolicy(path, config.maxPolicyBytes, 'synthetic-binding-secret-32-characters', scope.sourceSystem)
  const current = { id: claim.inpatId, inpat_code: claim.inpatCode!, current_dept_code: scope.departmentCode, inpat_state_code: '4' }
  const patients = [101, 102, 103].map(id => ({ inpat_id: String(id), inpat_code: `visit-${id}`, patient_name: `Synthetic ${id}`, bed_name: String(id) }))
  const query = vi.fn<ReadTransaction['query']>(async (sql) => {
    if (sql === encounterIdentitySql) return [{ ...current }]
    if (sql === departmentsSql) return [{ hospital_code: scope.hospitalCode, department_code: scope.departmentCode, department_name: 'Synthetic Department' }]
    if (sql === patientsSql) return patients
    if (sourceQueries.some(source => source.sql === sql)) return []
    throw new Error('Unexpected SQL')
  })
  const database: ReadDatabase = { read: async (_signal, read) => read({ query }) }
  return { root, path, save, config, policy, current, query, database,
    directory: new PgEncounterDirectory(config, policy, database), reader: new PgEncounterReader(ctx, config, policy, database) }
}

describe('department-scoped clinical directory', () => {
  it('lists only configured actor grants and returns bounded minimal patient pages', async () => {
    const world = await fixture()
    const departments = await world.directory.departments(actor, new AbortController().signal)
    expect(departments).toEqual({ departments: [{ ...scope, departmentName: 'Synthetic Department' }] })
    const result = await world.directory.patients(actor, request, new AbortController().signal)
    expect(result).toEqual({ ...request, hasMore: true, patients: [
      { inpatId: '101', inpatCode: 'visit-101', patientName: 'Synthetic 101', bedName: '101' },
      { inpatId: '102', inpatCode: 'visit-102', patientName: 'Synthetic 102', bedName: '102' },
    ] })
    expect(world.query).toHaveBeenCalledWith(patientsSql, ['1001', 'dept-one', 'true', '[]', '', 3, 0])
  })
  it('binds literal search and page offsets without interpreting SQL fragments', async () => {
    const world = await fixture()
    const search = "%' OR true --"
    await world.directory.patients(actor, { ...request, pageIndex: 3, search }, new AbortController().signal)
    expect(world.query).toHaveBeenCalledWith(patientsSql, ['1001', 'dept-one', 'true', '[]', search, 3, 4])
    expect(patientsSql).not.toContain(search)
  })
  it('rejects caller account overrides, invalid pages and cross-source or cross-hospital access', async () => {
    const world = await fixture()
    expect(() => patientDirectoryRequestSchema.parse({ ...request, subject: actor.subject })).toThrow()
    for (const invalid of [{ ...request, pageIndex: 0 }, { ...request, pageSize: 1001 }]) {
      expect(() => patientDirectoryRequestSchema.parse(invalid)).toThrow()
    }
    for (const invalid of [{ ...request, sourceSystem: 'other' }, { ...request, hospitalCode: 'other' }, { ...request, departmentCode: 'other' }]) {
      await expect(world.directory.patients(actor, invalid, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' })
    }
    await expect(world.directory.patients({ ...actor, subject: 'other' }, request, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' })
    expect(world.query).not.toHaveBeenCalled()
    expect(await world.directory.departments({ ...actor, issuer: 'https://other.test' }, new AbortController().signal)).toEqual({ departments: [] })
  })
  it('retains exact encounter grants without authorizing their whole department', async () => {
    const world = await fixture()
    await writeFile(world.path, JSON.stringify({ schemaVersion: 1, entries: [{ ...grant, departmentCode: undefined, inpatId: '101' }] }))
    await world.directory.patients(actor, request, new AbortController().signal)
    expect(world.query).toHaveBeenCalledWith(patientsSql, ['1001', 'dept-one', 'false', '[{"inpat_id":"101"}]', '', 3, 0])
    await expect(world.reader.resolve(actor, { ...claim, inpatId: '102' }, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('constrains exact encounter directory rows to their configured admission code', async () => {
    const world = await fixture()
    const exact = { issuer: actor.issuer, subject: actor.subject, sourceSystem: scope.sourceSystem,
      hospitalCode: scope.hospitalCode, inpatId: '101', inpatCode: 'approved-admission' }
    await writeFile(world.path, JSON.stringify({ schemaVersion: 1, entries: [exact] }))
    world.query.mockImplementation(async (sql, values) => {
      if (sql === departmentsSql) {
        expect(sql).toContain('a.inpat_code = r.inpat_code')
        expect(JSON.parse(String(values[0]))).toEqual([{ hospital_code: '1001', inpat_id: '101', inpat_code: 'approved-admission' }])
        return []
      }
      expect(sql).toBe(patientsSql)
      expect(sql).toContain('allowed.inpat_code = r.inpat_code')
      expect(JSON.parse(String(values[3]))).toEqual([{ inpat_id: '101', inpat_code: 'approved-admission' }])
      return []
    })
    expect(await world.directory.departments(actor, new AbortController().signal)).toEqual({ departments: [] })
    expect((await world.directory.patients(actor, request, new AbortController().signal)).patients).toEqual([])
  })
  it('checks current department on launch, capture and saved-result authorization', async () => {
    const world = await fixture()
    const binding = await world.reader.resolve(actor, claim, new AbortController().signal)
    expect(await world.reader.authorize(actor, binding, new AbortController().signal)).toEqual(binding)
    expect((await world.reader.capture(actor, binding, new AbortController().signal)).sources).toEqual([])
    world.current.current_dept_code = 'other-department'
    for (const operation of [
      () => world.reader.resolve(actor, claim, new AbortController().signal),
      () => world.reader.authorize(actor, binding, new AbortController().signal),
      () => world.reader.capture(actor, binding, new AbortController().signal),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'forbidden' })
    world.current.current_dept_code = scope.departmentCode
    world.current.inpat_state_code = '6'
    await expect(world.reader.authorize(actor, binding, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('revokes existing bindings before further SQL when the department grant is removed', async () => {
    const world = await fixture()
    const binding = await world.reader.resolve(actor, claim, new AbortController().signal)
    await world.save([])
    world.query.mockClear()
    await expect(world.reader.authorize(actor, binding, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(world.reader.capture(actor, binding, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(world.directory.patients(actor, request, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' })
    expect(world.query).not.toHaveBeenCalled()
  })
  it('rejects aliases that were not configured by a department grant', async () => {
    const world = await fixture()
    await expect(world.reader.resolve(actor, { ...claim, sourceVisitId: 'guessed' }, new AbortController().signal)).rejects.toMatchObject({ code: 'source-mismatch' })
    expect(world.query).not.toHaveBeenCalled()
  })
  it('rejects revoked policy and logout during a directory read without releasing rows', async () => {
    const world = await fixture()
    world.query.mockImplementationOnce(async () => { await world.save([]); return [] })
    await expect(world.directory.patients(actor, request, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' })
    await world.save()
    let active = true
    world.query.mockImplementationOnce(async () => { active = false; return [] })
    await expect(world.directory.patients(actor, request, new AbortController().signal, () => active)).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('enforces configured page size, complete UTF-8 response bounds, and cancellation', async () => {
    const world = await fixture({ maxDirectoryPageSize: 1 })
    await expect(world.directory.patients(actor, request, new AbortController().signal)).rejects.toMatchObject({ code: 'limit-exceeded' })
    expect(world.query).not.toHaveBeenCalled()
    world.config.maxResponseBytes = 1
    await expect(world.directory.patients(actor, { ...request, pageSize: 1 }, new AbortController().signal)).rejects.toMatchObject({ code: 'limit-exceeded' })
    const cancelled = new AbortController(); cancelled.abort()
    await expect(world.directory.departments(actor, cancelled.signal)).rejects.toMatchObject({ code: 'cancelled' })
  })
  it('fails closed for duplicate department grants and database outage during department authorization', async () => {
    const world = await fixture()
    const binding = await world.reader.resolve(actor, claim, new AbortController().signal)
    await world.save([grant, grant])
    await expect(world.policy.validate()).rejects.toMatchObject({ code: 'source-unavailable' })
    await world.save()
    world.query.mockRejectedValueOnce(new Error('synthetic database outage'))
    await expect(world.reader.authorize(actor, binding, new AbortController().signal)).rejects.toThrow('synthetic database outage')
  })
})
