/** Opt-in PostgreSQL execution against an owned Docker container and entirely synthetic source rows. */
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PgReadDatabase } from '@deepseek-ai/dsh-experimental-emr-reader-broker'
import { readCase } from '../src/case-query.ts'
import { readHistory } from '../src/history-query.ts'
import { readPathway } from '../src/pathway-query.ts'
import { caseRequestSchema, historyRequestSchema, pathwayRequestSchema, type QueryLimits } from '../src/protocol.ts'
import type { QueryContext } from '../src/query.ts'
import { verifySource } from '../src/source-check.ts'

const enabled = process.env.DSH_CLINICAL_PATHWAY_PG_TEST === '1'
const dockerAvailable = enabled && spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10000, stdio: 'ignore' }).status === 0
const execute = promisify(execFile)
const limits: QueryLimits = { maxRows: 100, maxRowBytes: 65536, maxQueryBytes: 1048576, maxTextChars: 4000,
  maxBranchDepth: 4, maxBranches: 10, herbalTables: true, operationTables: true, dictionaryTables: true }
const scope = { hospitalCode: 'h1', departmentCodes: ['dept1'], departmentBasis: 'current' as const,
  admissionFrom: '2024-01-01T00:00:00Z', admissionTo: '2026-01-01T00:00:00Z' }
const history = { from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z', timeBasis: 'admission' }

describe.skipIf(!enabled || !dockerAvailable)('synthetic PostgreSQL integration (requires DSH_CLINICAL_PATHWAY_PG_TEST=1 and Docker)', () => {
  const container = `dsh-pathway-pg-${randomUUID()}`
  let created = false
  let port = 0
  let admin: pg.Client | undefined
  let database: PgReadDatabase
  let developerDatabase: PgReadDatabase
  const developmentLimits: QueryLimits = { ...limits, allowWritableDevelopmentRole: true }
  const docker = async (...args: string[]) => (await execute('docker', args, { timeout: 30000, maxBuffer: 1048576 })).stdout.trim()

  afterAll(async () => {
    try { await admin?.end() } finally { if (created) await docker('rm', '--force', '--volumes', container) }
  }, 60000)

  beforeAll(async () => {
    await docker('image', 'inspect', 'postgres:16-alpine')
    await docker('create', '--name', container, '--pull=never', '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_PASSWORD=synthetic-admin-password', '--env', 'POSTGRES_DB=clinical_fixture', '--env', 'TZ=UTC', 'postgres:16-alpine')
    created = true
    await docker('start', container)
    await vi.waitFor(async () => { await docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'clinical_fixture') },
      { timeout: 30000, interval: 100 })
    port = Number(await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container))
    expect(port).toBeGreaterThan(0)
    admin = new pg.Client({ host: '127.0.0.1', port, database: 'clinical_fixture', user: 'postgres', password: 'synthetic-admin-password' })
    await admin.connect()
    await admin.query(await readFile(new URL('./fixtures/postgres.sql', import.meta.url), 'utf8'))
    database = new PgReadDatabase({ host: '127.0.0.1', port, database: 'clinical_fixture', user: 'fixture_reader', password: 'synthetic-reader-password' }, 10000)
    developerDatabase = new PgReadDatabase({ host: '127.0.0.1', port, database: 'clinical_fixture', user: 'fixture_developer', password: 'synthetic-developer-password' }, 10000)
  }, 60000)

  async function read<T>(
    operation: (ctx: QueryContext) => Promise<T>, configuredLimits: QueryLimits = limits, source = database,
  ): Promise<T> {
    const signal = AbortSignal.timeout(15000)
    return source.read(signal, async (tx) => {
      await verifySource(tx, 'clinical_source', configuredLimits)
      return operation({ tx, scope, limits: configuredLimits, signal })
    })
  }

  it('executes document substrings with NULL, empty and multiple content versions intact', async () => {
    const metadata = await read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'documents' })))
    expect(metadata.collections.documents?.map(row => row.id)).toEqual(['701:801', '701:802', '702:missing', '703:803', '704:804'])
    expect(metadata.collections.documents?.every(row => row.text === null)).toBe(true)
    expect(metadata.collections.documents?.filter(row => row.readable === false)).toHaveLength(3)
    const passages = await read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'documents', recordId: '701', start: 1, length: 2 })))
    expect(passages.collections.documents?.map(row => [row.contentId, row.fileVersion, row.text, row.nextStart])).toEqual([
      ['801', '2', '乙丙', 3], ['802', '10', '一个', 3],
    ])
    expect(passages.truncated).toBe(true)
    const exact = await read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'documents', contentId: '801', start: 3, length: 20 })))
    expect(exact.collections.documents).toHaveLength(1)
    expect(exact.collections.documents?.[0]).toMatchObject({ text: '丁戊', nextStart: null })
    expect(exact.truncated).toBe(false)
  })

  it('executes encounter, diagnosis and order projections with hospital and department denial', async () => {
    const encounter = await read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'encounter' })))
    expect(encounter.collections.encounter?.[0]?.inpatId).toBe('101')
    const diagnoses = await read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'diagnoses' })))
    expect(diagnoses.collections.diagnoses).toHaveLength(3)
    expect(diagnoses.collections.diagnoses?.map(row => row.state)).toEqual(['recorded', 'suspected', 'deleted'])
    const orders = await read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'orders' })))
    expect(orders.collections.orders?.map(row => row.id)).toEqual(['501', '502'])
    expect(orders.collections.orders?.every(row => row.availableAt === null)).toBe(true)
    for (const inpatId of ['104', '105', '106', '107']) {
      await expect(read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId, category: 'encounter' })))).rejects.toMatchObject({ code: 'not-found' })
    }
  })

  it('counts all matched admissions and executions independently of diagnosis multiplicity and page size', async () => {
    const result = await read(ctx => readHistory(ctx, historyRequestSchema.parse({ ...history, mode: 'cohort', limit: 1 })))
    expect(result.measures).toMatchObject({ admissionCount: 3, executionCount: 5, admissionsWithoutExecutionCount: 1,
      notIncludedCount: 1, underwayCount: 1, exitCount: 1, systemMarkedCompleteCount: 1, offPathwayTreatmentCount: 1,
      currentReasonCount: 2, reasonVariationTrueCount: 1, reasonVariationUnknownCount: 1, unknownTreatmentPackageFlagCount: 1 })
    expect(result.collections.admissions?.map(row => row.inpatId)).toEqual(['101'])
    expect(result.nextOffset).toBe(1)
    expect(result.collections.reasons?.map(row => row.id)).toEqual(['401'])
    expect(result.collections.orders?.map(row => row.orderId)).toEqual(['501', '502'])
    expect(result.collections.itemExecutions?.[0]?.itemId).toBe('502')
    const noExecution = await read(ctx => readHistory(ctx, historyRequestSchema.parse({ ...history, mode: 'cohort', limit: 1, offset: 1 })))
    expect(noExecution.collections.admissions?.map(row => row.inpatId)).toEqual(['102'])
    expect(noExecution.collections.executions).toEqual([])
    expect(noExecution.measures.admissionCount).toBe(3)
    const diagnosed = await read(ctx => readHistory(ctx, historyRequestSchema.parse({ ...history, diagnosisCode: 'J18', diagnosisType: '10' })))
    expect(diagnosed.measures).toMatchObject({ admissionCount: 2, executionCount: 1, admissionsWithoutExecutionCount: 1 })
    const literal = await read(ctx => readHistory(ctx, historyRequestSchema.parse({ ...history, diagnosisCode: "J18' OR true --" })))
    expect(literal.measures.admissionCount).toBe(0)
  })

  it('applies execution identity, status and half-open creation time to the same execution row', async () => {
    const selected = await read(ctx => readHistory(ctx, historyRequestSchema.parse({ ...history, timeBasis: 'execution',
      from: '2025-04-03T00:00:00Z', to: '2025-04-04T00:00:00Z', pathwayId: '2', executionStatus: '2', mode: 'cohort' })))
    expect(selected.measures).toMatchObject({ admissionCount: 1, executionCount: 1, exitCount: 1, admissionsWithoutExecutionCount: 0 })
    expect(selected.collections.executions?.[0]).toMatchObject({ id: '203', pathwayId: '2', versionNo: 2 })
    const incompatible = await read(ctx => readHistory(ctx, historyRequestSchema.parse({ ...history, pathwayId: '1', executionStatus: '2' })))
    expect(incompatible.measures.admissionCount).toBe(0)
  })

  it('expands predecessor order and scoped branches with optional herbal and dictionary sources', async () => {
    const result = await read(ctx => readPathway(ctx, pathwayRequestSchema.parse({ pathwayId: '1' })))
    expect(result.collections.pathways?.map(row => row.id)).toEqual(['1', '2'])
    expect(result.collections.nodes?.filter(row => row.clinical_pathway_id === '1').map(row => row.id)).toEqual(['20', '10'])
    expect(result.collections.items?.map(row => row.id).sort()).toEqual(['40', '41'])
    expect(result.collections.herbalRecipes?.[0]).toMatchObject({ item_id: '40', decoction_dosage: '200.25' })
    expect(result.collections.herbalDetails?.map(row => row.id)).toEqual(['43', '42'])
    expect(result.collections.dictionary?.map(row => row.id)).toEqual(['1'])
    expect(result.collections.drugParameters).toHaveLength(1)
    expect(result.collections.drugParameters?.[0]).toMatchObject({ cur_hospital_code: 'h1', drug_code: 'ORDER',
      base_dose: '0', base_dose1: '1.25', base_unit_name1: 'Synthetic unit', skin_test_flag: false })
    expect(result.collections.operations?.map(row => row.id)).toEqual(['1'])
    expect(result.coverage.join('\n')).toContain('cyclic definition references')
    expect(result.coverage.join('\n')).toContain('some referenced definitions are unavailable')
    const optionalDisabled = await read(ctx => readPathway(ctx, pathwayRequestSchema.parse({ pathwayId: '1' })),
      { ...limits, herbalTables: false, operationTables: false, dictionaryTables: false })
    expect(optionalDisabled.collections.herbalRecipes).toBeUndefined()
    expect(optionalDisabled.collections.drugParameters).toBeUndefined()
    expect(optionalDisabled.coverage.join('\n')).toContain('optional sources are not enabled')
    const denied = await read(ctx => readPathway(ctx, pathwayRequestSchema.parse({ pathwayId: '3' })))
    expect(denied.collections.pathways).toEqual([])
    const candidates = await read(ctx => readPathway(ctx, pathwayRequestSchema.parse({ search: 'definition' })))
    expect(candidates.collections.pathways?.map(row => row.id)).toEqual(['6'])
    const shared = await read(ctx => readPathway({ ...ctx, scope: { ...ctx.scope, includeSharedDefinitions: true } }, pathwayRequestSchema.parse({ pathwayId: '5' })))
    expect(shared.collections.pathways?.map(row => row.id)).toEqual(['5'])
  })

  it('rejects source writes through both the transaction and the dedicated role', async () => {
    await expect(read(ctx => ctx.tx.query('UPDATE clinical_source.cpoe_inpat_record SET inpat_code=$1 WHERE inpat_id=101', ['changed'])))
      .rejects.toMatchObject({ code: 'source-unavailable', cause: { code: '25006' } })
    const client = new pg.Client({ host: '127.0.0.1', port, database: 'clinical_fixture', user: 'fixture_reader', password: 'synthetic-reader-password' })
    try {
      await client.connect()
      await client.query('SET default_transaction_read_only=off')
      await expect(client.query("UPDATE clinical_source.cpoe_inpat_record SET inpat_code='changed' WHERE inpat_id=101"))
        .rejects.toMatchObject({ code: '42501' })
    } finally { await client.end() }
    expect((await admin!.query<{ inpat_code: string }>('SELECT inpat_code FROM clinical_source.cpoe_inpat_record WHERE inpat_id=101')).rows[0]?.inpat_code).toBe('synthetic-101')
  })

  it('requires explicit development policy for a writable role and still rejects source DML', async () => {
    const encounter = (ctx: QueryContext) => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'encounter' }))
    await expect(read(encounter, limits, developerDatabase)).rejects.toMatchObject({ code: 'source-unavailable' })
    await expect(read(encounter, { ...developmentLimits, allowWritableDevelopmentRole: false }, developerDatabase))
      .rejects.toMatchObject({ code: 'source-unavailable' })
    const result = await read(encounter, developmentLimits, developerDatabase)
    expect(result.collections.encounter?.[0]?.inpatId).toBe('101')
    await expect(read(ctx => ctx.tx.query('UPDATE clinical_source.cpoe_inpat_record SET inpat_code=$1 WHERE inpat_id=101', ['changed']),
      developmentLimits, developerDatabase)).rejects.toMatchObject({ code: 'source-unavailable', cause: { code: '25006' } })
    expect((await admin!.query<{ inpat_code: string }>('SELECT inpat_code FROM clinical_source.cpoe_inpat_record WHERE inpat_id=101')).rows[0]?.inpat_code).toBe('synthetic-101')
  })

  it('does not waive read-only transactions or source schema checks for the development role', async () => {
    const client = new pg.Client({ host: '127.0.0.1', port, database: 'clinical_fixture', user: 'fixture_developer', password: 'synthetic-developer-password' })
    try {
      await client.connect()
      await client.query('BEGIN')
      const state = await client.query<{ read_only: string; writable: boolean; unsafe_role: boolean }>(`SELECT
        current_setting('transaction_read_only') AS read_only,
        has_table_privilege(current_user,'clinical_source.cpoe_inpat_record','UPDATE') AS writable,
        rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS unsafe_role
        FROM pg_roles WHERE rolname=current_user`)
      expect(state.rows).toEqual([{ read_only: 'off', writable: true, unsafe_role: false }])
      const transaction = { query: async (sql: string, values: readonly (string | number)[]) =>
        (await client.query<Record<string, unknown>>(sql, [...values])).rows }
      await expect(verifySource(transaction, 'clinical_source', developmentLimits))
        .rejects.toMatchObject({ code: 'source-unavailable' })
    } finally {
      try { await client.query('ROLLBACK') } finally { await client.end() }
    }
    await expect(developerDatabase.read(AbortSignal.timeout(15000), tx => verifySource(tx, 'missing_source', developmentLimits)))
      .rejects.toMatchObject({ code: 'source-unavailable' })
  })

  it('requires SELECT privileges even when development policy permits the role to write', async () => {
    await admin!.query('REVOKE SELECT ON clinical_source.cpoe_inpat_record FROM fixture_developer')
    try {
      await expect(read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'encounter' })), developmentLimits, developerDatabase))
        .rejects.toMatchObject({ code: 'source-unavailable' })
    } finally { await admin!.query('GRANT SELECT ON clinical_source.cpoe_inpat_record TO fixture_developer') }
  })

  it('rejects oversized source JSON instead of emitting a null record or an empty result', async () => {
    await expect(read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'encounter' })),
      { ...limits, maxRowBytes: 16 })).rejects.toMatchObject({ code: 'limit-exceeded' })
    await expect(read(ctx => readHistory(ctx, historyRequestSchema.parse(history)),
      { ...limits, maxQueryBytes: 16 })).rejects.toMatchObject({ code: 'limit-exceeded' })
  })

  it('fails source verification when a required physical column is missing', async () => {
    await admin!.query('ALTER TABLE clinical_source.cpoe_inpat_order RENAME COLUMN cp_exec_id TO unavailable_cp_exec_id')
    try {
      await expect(read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'orders' })))).rejects.toMatchObject({ code: 'source-unavailable' })
      await expect(read(ctx => readCase(ctx, caseRequestSchema.parse({ inpatId: '101', category: 'orders' })), developmentLimits, developerDatabase))
        .rejects.toMatchObject({ code: 'source-unavailable' })
    } finally { await admin!.query('ALTER TABLE clinical_source.cpoe_inpat_order RENAME COLUMN unavailable_cp_exec_id TO cp_exec_id') }
  })
})
