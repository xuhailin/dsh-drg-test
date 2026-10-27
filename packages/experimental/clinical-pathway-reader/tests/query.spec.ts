/** Driver-boundary validation and fixed-query parameter binding; no database or model is contacted. */
import { expect, it, vi } from 'vitest'
import type { ReadTransaction } from '@deepseek-ai/dsh-experimental-emr-reader-broker'
import { admissionScope, emptyResult, rows, scopeValues, type QueryContext } from '../src/query.ts'

function fixture(source: readonly unknown[] = []) {
  const controller = new AbortController()
  const query = vi.fn<ReadTransaction['query']>(async () => source)
  const ctx: QueryContext = { tx: { query }, signal: controller.signal,
    scope: { hospitalCode: 'hospital-one', departmentCodes: ['department-one'], departmentBasis: 'current',
      admissionFrom: '2025-01-01T00:00:00Z', admissionTo: '2026-01-01T00:00:00Z' },
    limits: { maxRows: 3, maxRowBytes: 1024, maxQueryBytes: 4096, maxTextChars: 500,
      maxBranchDepth: 2, maxBranches: 3, herbalTables: false },
  }
  return { ctx, query, controller }
}

it('adds SQL-side byte and row bounds after bound selector values without changing valid JSON evidence', async () => {
  const records = [{ id: '1', nullValue: null, states: [true, false, 3], nested: { text: '合成资料' } }]
  const world = fixture(records.map(data => ({ data })))
  const sql = "SELECT jsonb_build_object('id',$1::text) AS data"
  const selector = "source'); DROP TABLE forbidden; --"
  await expect(rows(world.ctx, sql, [selector])).resolves.toEqual(records)
  const [statement, values] = world.query.mock.calls[0]!
  expect(statement).toContain(`WITH dsh_source AS (${sql})`)
  expect(statement).toContain('octet_length(data::text)>$2::int')
  expect(statement).toContain('sum(octet_length(data::text)) OVER ()>$3::int')
  expect(statement).toContain('LIMIT $4::int')
  expect(statement).not.toContain(selector)
  expect(values).toEqual([selector, 1024, 4096, 4])
})

it.each([
  { label: 'missing data', row: {} }, { label: 'array data', row: { data: [] } },
  { label: 'scalar data', row: { data: 'invalid' } }, { label: 'non-JSON value', row: { data: { id: 1n } } },
])(
  'rejects malformed driver rows without retaining partial evidence: $label', async ({ row }) => {
    const world = fixture([{ data: { id: '1' } }, row])
    await expect(rows(world.ctx, 'SELECT synthetic AS data', [])).rejects.toMatchObject({ code: 'source-unavailable' })
  },
)

it('rejects a SQL byte-limit marker even after a valid row', async () => {
  const world = fixture([{ data: { id: '1' } }, { data: null }])
  await expect(rows(world.ctx, 'SELECT synthetic AS data', [])).rejects.toMatchObject({ code: 'limit-exceeded' })
})

it('distinguishes a valid empty result from an unavailable source', async () => {
  const world = fixture()
  await expect(rows(world.ctx, 'SELECT synthetic AS data', [])).resolves.toEqual([])
  const error = new Error('Synthetic connection unavailable')
  world.query.mockRejectedValueOnce(error)
  await expect(rows(world.ctx, 'SELECT synthetic AS data', [])).rejects.toBe(error)
})

it('does not query a cancelled read and discards a result cancelled while the driver was running', async () => {
  const before = fixture()
  const reason = new Error('Synthetic read cancelled')
  before.controller.abort(reason)
  await expect(rows(before.ctx, 'SELECT synthetic AS data', [])).rejects.toBe(reason)
  expect(before.query).not.toHaveBeenCalled()
  const during = fixture()
  during.query.mockImplementation(async () => { during.controller.abort(reason); return [{ data: { id: '1' } }] })
  await expect(rows(during.ctx, 'SELECT synthetic AS data', [])).rejects.toBe(reason)
  expect(during.query).toHaveBeenCalledTimes(1)
})

it.each(['current', 'discharge'] as const)('keeps the %s department and admission grant in fixed predicates and bound values', (basis) => {
  const world = fixture()
  world.ctx.scope.departmentBasis = basis
  world.ctx.scope.departmentCodes = ["department' OR true --"]
  const predicate = admissionScope(world.ctx, 'r')
  expect(predicate).toContain(`r.${basis === 'current' ? 'current_dept_code' : 'out_dept_code'} IN`)
  expect(predicate).toContain('r.in_time >= $3::timestamptz AND r.in_time < $4::timestamptz')
  expect(predicate).not.toContain(world.ctx.scope.departmentCodes[0])
  expect(scopeValues(world.ctx)).toEqual(['hospital-one', '["department\' OR true --"]',
    world.ctx.scope.admissionFrom, world.ctx.scope.admissionTo])
})

it('returns fresh result collections for each read', () => {
  const first = emptyResult(), second = emptyResult()
  first.collections.synthetic = [{ id: '1' }]
  first.coverage.push('synthetic gap')
  expect(second).toEqual({ collections: {}, measures: {}, nextOffset: null, truncated: false, coverage: [] })
})
