/** Synthetic evidence validates authorization, snapshot completeness and source-state semantics. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parseBinding, type ClinicalActor, type LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Config } from '../src/config.ts'
import type { ReadDatabase, ReadTransaction } from '../src/database.ts'
import { EncounterPolicy } from '../src/policy.ts'
import { PgEncounterReader } from '../src/reader.ts'
import { sourceQueries } from '../src/sql.ts'

const actor: ClinicalActor = { id: 'account-one', issuer: 'https://sso.test', subject: 'doctor-one' }
const claim: LaunchClaim = { eventId: 'event-one', trigger: 'manual-review', sourceSystem: 'fixture-emr', hospitalCode: 'hospital-one', inpatId: '100', inpatCode: 'visit-100' }
function row(id: string, state = 'recorded', body: Record<string, string | number | boolean | null> = { text: 'Synthetic original evidence.' }) {
  return { id, state, occurred_at: '2026-01-01 10:00:00', available_at: '2026-01-01 11:00:00', oversized: false, body }
}
async function fixture(overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-emr-reader-'))
  const context = new Context()
  onTestFinished(async () => { await context.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const path = join(root, 'access.json')
  const entry = {
    issuer: actor.issuer, subject: actor.subject, sourceSystem: claim.sourceSystem,
    hospitalCode: claim.hospitalCode, inpatId: claim.inpatId, inpatCode: claim.inpatCode,
  }
  await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [entry] }))
  const config = Config({ sourceSystem: claim.sourceSystem, allowlistFile: path, databaseConfigFile: '/fixture/database', bindingKeyFile: '/fixture/key', ...overrides })
  const policy = new EncounterPolicy(path, config.maxPolicyBytes, 'synthetic-binding-secret-32-characters', claim.sourceSystem)
  const rows = new Map(sourceQueries.map(query => [query.category, [row(query.category)]]))
  const query = vi.fn<ReadTransaction['query']>(async (sql) => {
    const source = sourceQueries.find(item => item.sql === sql)
    return source === undefined ? [{ id: '100', inpat_code: 'visit-100' }] : rows.get(source.category) ?? []
  })
  const database: ReadDatabase = { read: async (_signal, read) => read({ query }) }
  const reader = new PgEncounterReader(context, config, policy, database)
  const binding = await reader.resolve(actor, claim, new AbortController().signal)
  query.mockClear()
  return { root, path, entry, config, policy, rows, query, reader, binding }
}

describe('controlled encounter reader', () => {
  it('keeps a case revision stable across capture times and changes it when original evidence changes', async () => {
    const world = await fixture()
    const clock = vi.spyOn(Date.prototype, 'toISOString')
      .mockReturnValueOnce('2026-01-01T12:00:00.000Z')
      .mockReturnValueOnce('2026-01-01T12:01:00.000Z')
    onTestFinished(() => { clock.mockRestore() })
    const first = await world.reader.capture(actor, world.binding, new AbortController().signal)
    const repeated = await world.reader.capture(actor, world.binding, new AbortController().signal)
    expect(repeated.capturedAt).not.toBe(first.capturedAt)
    expect(repeated.caseRevision).toBe(first.caseRevision)
    world.rows.set('diagnoses', [row('diagnoses', 'corrected', { text: 'Updated synthetic evidence.' })])
    const changed = await world.reader.capture(actor, world.binding, new AbortController().signal)
    expect(changed.caseRevision).not.toBe(first.caseRevision)
  })
  it('retains original states, marks missing document text unread and unsupported sources explicitly', async () => {
    const world = await fixture()
    world.rows.set('orders', [row('20', '14', { stateId: 14, isRevokeOrder: true, execNum: 1 })])
    world.rows.set('documents', [row('30', 'unreadable', { text: null })])
    const result = await world.reader.capture(actor, world.binding, new AbortController().signal)
    expect(result.sources.find(source => source.category === 'orders')?.state).toBe('14')
    expect(result.coverage.find(item => item.category === 'documents')?.status).toBe('unread')
    expect(result.coverage.find(item => item.category === 'administration')?.status).toBe('unsupported')
    expect(result.sources.every(source => /^[a-f0-9]{64}$/.test(source.contentDigest))).toBe(true)
    expect(world.query.mock.calls.every(call => call[1][0] === '100' && call[1][1] === 'hospital-one')).toBe(true)
  })
  it('denies a different actor and a modified patient before any SQL', async () => {
    const world = await fixture()
    await expect(world.reader.capture({ ...actor, subject: 'other' }, world.binding, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-binding' })
    await expect(world.reader.capture(actor, parseBinding({ ...world.binding, inpatId: '101' }), new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-binding' })
    expect(world.query).not.toHaveBeenCalled()
  })
  it('denies removed allowlist entries after a binding was issued', async () => {
    const world = await fixture()
    await writeFile(world.path, JSON.stringify({ schemaVersion: 1, entries: [] }))
    await expect(world.reader.capture(actor, world.binding, new AbortController().signal)).rejects.toMatchObject({ code: 'forbidden' })
    expect(world.query).not.toHaveBeenCalled()
  })
  it('rejects aliases that disagree with either approved mapping or current database', async () => {
    const world = await fixture()
    await expect(world.reader.resolve(actor, { ...claim, sourceVisitId: 'unverified-source-id' }, new AbortController().signal)).rejects.toMatchObject({ code: 'source-mismatch' })
    world.query.mockResolvedValueOnce([{ id: '100', inpat_code: 'changed-admission' }])
    await expect(world.reader.capture(actor, world.binding, new AbortController().signal)).rejects.toMatchObject({ code: 'source-mismatch' })
  })
  it('rejects category overflow and complete UTF-8 response overflow without a partial snapshot', async () => {
    const world = await fixture({ maxRowsPerCategory: 1 })
    world.rows.set('diagnoses', [row('1'), row('2')])
    await expect(world.reader.capture(actor, world.binding, new AbortController().signal)).rejects.toMatchObject({ code: 'limit-exceeded' })
    world.rows.set('diagnoses', [row('1')])
    world.config.maxResponseBytes = 1
    await expect(world.reader.capture(actor, world.binding, new AbortController().signal)).rejects.toMatchObject({ code: 'limit-exceeded' })
  })
  it('rejects oversized single source and does not interpret a missing body as empty', async () => {
    const world = await fixture()
    world.query.mockImplementation(async sql => sql === sourceQueries[0]!.sql ? [{ ...row('1'), body: null, oversized: true }] : [{ id: '100', inpat_code: 'visit-100' }])
    await expect(world.reader.capture(actor, world.binding, new AbortController().signal)).rejects.toMatchObject({ code: 'limit-exceeded' })
  })
  it('stops on logout between source queries and rejects pre-cancelled capture', async () => {
    const world = await fixture()
    let reads = 0
    await expect(world.reader.capture(actor, world.binding, new AbortController().signal, () => ++reads < 4)).rejects.toMatchObject({ code: 'forbidden' })
    const cancelled = new AbortController(); cancelled.abort()
    const before = world.query.mock.calls.length
    await expect(world.reader.capture(actor, world.binding, cancelled.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(world.query).toHaveBeenCalledTimes(before)
  })
  it('accepts issued bindings after service reconstruction with the same key', async () => {
    const world = await fixture()
    const restored = new EncounterPolicy(world.path, world.config.maxPolicyBytes, 'synthetic-binding-secret-32-characters', claim.sourceSystem)
    expect(() =>{  restored.verify(actor, world.binding) }).not.toThrow()
    const rotated = new EncounterPolicy(world.path, world.config.maxPolicyBytes, 'different-binding-secret-32-characters', claim.sourceSystem)
    expect(() =>{  rotated.verify(actor, world.binding) }).toThrow(expect.objectContaining({ code: 'invalid-binding' }))
  })
})
