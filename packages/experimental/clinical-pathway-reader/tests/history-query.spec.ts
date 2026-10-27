/** Synthetic transaction responses test bounded assembly; PostgreSQL integration owns SQL execution evidence. */
import { describe, expect, it, vi } from 'vitest'
import { readHistory } from '../src/history-query.ts'
import { historyRequestSchema, type ClinicalSourceRow } from '../src/protocol.ts'
import type { QueryContext } from '../src/query.ts'

const baseRequest = { from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z', timeBasis: 'admission' }
const summary: ClinicalSourceRow = {
  admissionCount: 0, executionCount: 0, admissionsWithoutExecutionCount: 0, notIncludedCount: 0, underwayCount: 0,
  exitCount: 0, systemMarkedCompleteCount: 0, offPathwayTreatmentCount: 0, unknownExecutionStatusCount: 0,
  unknownExecutionDeletedFlagCount: 0, unknownTreatmentPackageFlagCount: 0, currentReasonCount: 0,
  reasonVariationTrueCount: 0, reasonVariationFalseCount: 0, reasonVariationUnknownCount: 0, executionsWithoutRetainedReasonCount: 0,
}
const queryNames = ['summary', 'admissions', 'diagnoses', 'executions', 'reasons', 'item-executions', 'orders'] as const
type QueryName = typeof queryNames[number]

function fixture(overrides: Partial<Record<QueryName, ClinicalSourceRow[]>> = {}) {
  const responses: Record<QueryName, ClinicalSourceRow[]> = {
    summary: [{ ...summary }], admissions: [], diagnoses: [], executions: [], reasons: [], 'item-executions': [], orders: [], ...overrides,
  }
  const query = vi.fn(async (sql: string, _values: readonly (string | number)[]): Promise<readonly unknown[]> => {
    const name = queryNames.find(candidate => sql.includes(`/* history:${candidate} */`))
    if (name === undefined) throw new Error('Unexpected fixed history query')
    return responses[name].map(data => ({ data }))
  })
  const controller = new AbortController()
  const ctx: QueryContext = {
    tx: { query }, signal: controller.signal,
    scope: { hospitalCode: 'hospital-one', departmentCodes: ['dept-one'], departmentBasis: 'current',
      admissionFrom: '2024-01-01T00:00:00Z', admissionTo: '2027-01-01T00:00:00Z' },
    limits: { maxRows: 2, maxRowBytes: 65536, maxQueryBytes: 1048576, maxTextChars: 4000,
      maxBranchDepth: 3, maxBranches: 10, herbalTables: false },
  }
  const call = (name: QueryName) => {
    const found = query.mock.calls.find(([sql]) => sql.includes(`/* history:${name} */`))
    if (found === undefined) throw new Error(`Expected ${name} query`)
    return found
  }
  return { ctx, query, controller, responses, call }
}

describe('historical pathway cohorts', () => {
  it('returns whole-cohort source counts without applying evidence pagination', async () => {
    const world = fixture({ summary: [{ ...summary, admissionCount: 24, executionCount: 27, admissionsWithoutExecutionCount: 5,
      systemMarkedCompleteCount: 8, currentReasonCount: 6, reasonVariationUnknownCount: 2 }] })
    const result = await readHistory(world.ctx, historyRequestSchema.parse({ ...baseRequest, offset: 8, limit: 1 }))
    expect(result).toMatchObject({ collections: {}, nextOffset: null, truncated: false,
      measures: { admissionCount: 24, executionCount: 27, systemMarkedCompleteCount: 8, currentReasonCount: 6 } })
    expect(world.query).toHaveBeenCalledTimes(1)
    const [sql, values] = world.call('summary')
    expect(values.slice(0, 13)).toEqual(['hospital-one', '["dept-one"]', world.ctx.scope.admissionFrom, world.ctx.scope.admissionTo,
      baseRequest.from, baseRequest.to, 'admission', '', '', '', 'icd', '', 'false'])
    expect(sql).not.toContain('OFFSET')
    expect(sql).toContain('count(DISTINCT p.inpat_id)')
    expect(sql).toContain('r.reason_type IN (0,1,2,4)')
    expect(result.coverage.join('\n')).toContain('not an immutable variation history')
    expect(result.coverage.join('\n')).toContain('No clinical completion rate is calculated')
  })

  it('binds every caller criterion and constrains executions on one matching record', async () => {
    const world = fixture()
    world.ctx.scope.departmentBasis = 'discharge'
    const diagnosis = "ICD' OR true --"
    await readHistory(world.ctx, historyRequestSchema.parse({ ...baseRequest, timeBasis: 'execution', pathwayId: '17',
      executionStatus: '3', diagnosisCode: diagnosis, diagnosisSystem: 'hospital', diagnosisType: '31', mainDiagnosisOnly: true }))
    const [sql, values] = world.call('summary')
    expect(sql).not.toContain(diagnosis)
    expect(values.slice(4, 13)).toEqual([baseRequest.from, baseRequest.to, 'execution', '17', '3', diagnosis, 'hospital', '31', 'true'])
    expect(sql).toContain('p.out_dept_code IN')
    expect(sql).toContain('e.pathway_id=NULLIF($8,\'\')::bigint')
    expect(sql).toContain('e.execution_status::text=$9')
    expect(sql).toContain('e.create_time >= $5::timestamptz')
    expect(sql).toContain('d.is_deleted IS NOT TRUE')
    expect(sql).toContain('e.is_treatment_package IS NOT TRUE')
    expect(sql).not.toContain('is_clinical_pathway')
  })

  it('retains admissions without execution and returns no fabricated child evidence', async () => {
    const world = fixture({ summary: [{ ...summary, admissionCount: 1, admissionsWithoutExecutionCount: 1 }],
      admissions: [{ inpatId: '101', stateCode: '7' }], diagnoses: [{ id: '301', inpatId: '101', isSuspected: true, isDeleted: null }] })
    const result = await readHistory(world.ctx, historyRequestSchema.parse({ ...baseRequest, mode: 'cohort' }))
    expect(result.collections).toEqual({ admissions: [{ inpatId: '101', stateCode: '7' }],
      diagnoses: [{ id: '301', inpatId: '101', isSuspected: true, isDeleted: null }], executions: [] })
    expect(result.nextOffset).toBeNull()
    expect(result.truncated).toBe(false)
    expect(world.query).toHaveBeenCalledTimes(4)
    expect(world.call('admissions')[0]).toContain("($7<>'execution' AND $8='' AND $9='') OR EXISTS")
    expect(world.call('diagnoses')[1].slice(0, 3)).toEqual(['hospital-one', '["101"]', 3])
  })

  it('pages admissions independently of aggregate totals and caps each child collection', async () => {
    const world = fixture({ summary: [{ ...summary, admissionCount: 12, executionCount: 19 }],
      admissions: [{ inpatId: '101' }, { inpatId: '102' }, { inpatId: '103' }],
      diagnoses: [{ id: '1' }, { id: '2' }, { id: '3' }],
      executions: [{ id: '201', inpatId: '101', pathwayId: '17', versionNo: 'old' }, { id: '202', inpatId: '102' }, { id: '203', inpatId: '102' }],
      reasons: [{ id: '401', reasonType: 2, executionItemId: '601', isVariation: null }, { id: '402', reasonType: 4, executionItemId: null }],
      'item-executions': [{ id: '501', itemId: '602' }, { id: '502', itemId: null }],
      orders: [{ orderId: '601', executionId: null }, { orderId: '602', executionId: '201' }, { orderId: '603', executionId: '202' }],
    })
    const result = await readHistory(world.ctx, historyRequestSchema.parse({ ...baseRequest, mode: 'cohort', offset: 4, limit: 20 }))
    expect(result.measures.admissionCount).toBe(12)
    expect(result.measures.executionCount).toBe(19)
    expect(result.nextOffset).toBe(6)
    expect(result.truncated).toBe(true)
    expect(result.collections.admissions).toEqual([{ inpatId: '101' }, { inpatId: '102' }])
    expect(result.collections.executions?.[0]).toMatchObject({ pathwayId: '17', versionNo: 'old' })
    expect(result.collections.reasons?.[0]?.isVariation).toBeNull()
    expect(result.collections.orders).toHaveLength(2)
    expect(world.call('admissions')[1].slice(13, 15)).toEqual([3, 4])
    expect(world.call('executions')[1].slice(13, 15)).toEqual(['["101","102"]', 3])
    expect(world.call('reasons')[1].slice(0, 3)).toEqual(['hospital-one', '["201","202"]', 3])
    expect(world.call('orders')[1].slice(0, 5)).toEqual(['hospital-one', '["101","102"]', '["201","202"]', '["601","602"]', 3])
    expect(world.call('orders')[0]).toContain('o.inpat_id IN')
    expect(world.call('reasons')[0]).toContain('r.reason_type IN (0,1,2,4)')
    expect(world.call('item-executions')[0]).not.toContain('JOIN cp_clinical_pathway_item')
    expect(result.coverage.join('\n')).toContain('itemExecutions.itemId and type-2 reasons.executionItemId are order IDs')
  })

  it('reports child truncation without advancing a completed admission page', async () => {
    const world = fixture({ admissions: [{ inpatId: '101' }], diagnoses: [{ id: '1' }, { id: '2' }, { id: '3' }],
      executions: [{ id: '201' }], reasons: [{ reasonType: 2, executionItemId: null }, { reasonType: 1, executionItemId: '99' }, { reasonType: 2, executionItemId: '100' }],
      'item-executions': [{ itemId: '21' }, { itemId: '21' }, { itemId: '22' }] })
    const result = await readHistory(world.ctx, historyRequestSchema.parse({ ...baseRequest, mode: 'cohort', limit: 1 }))
    expect(result.truncated).toBe(true)
    expect(result.nextOffset).toBeNull()
    expect(world.call('orders')[1][3]).toBe('["21"]')
    expect(result.collections.reasons).toHaveLength(2)
    expect(result.collections.itemExecutions).toHaveLength(2)
  })

  it('retains executions with no recorded reasons or item references without fabricating associated orders', async () => {
    const world = fixture({ summary: [{ ...summary, admissionCount: 1, executionCount: 1, executionsWithoutRetainedReasonCount: 1 }],
      admissions: [{ inpatId: '101' }], executions: [{ id: '201' }] })
    const result = await readHistory(world.ctx, historyRequestSchema.parse({ ...baseRequest, mode: 'cohort' }))
    expect(result.collections.executions).toEqual([{ id: '201' }])
    expect(result.collections.reasons).toEqual([])
    expect(result.collections.itemExecutions).toEqual([])
    expect(result.collections.orders).toEqual([])
    expect(result.measures.executionsWithoutRetainedReasonCount).toBe(1)
    expect(world.call('orders')[1].slice(0, 5)).toEqual(['hospital-one', '["101"]', '["201"]', '[]', 3])
    expect(result.coverage.join('\n')).toContain('A missing retained reason is not proof of no variation.')
    expect(result.truncated).toBe(false)
    expect(result.nextOffset).toBeNull()
  })

  it('returns an empty page with whole-cohort totals and performs no child queries', async () => {
    const world = fixture({ summary: [{ ...summary, admissionCount: 2 }] })
    const result = await readHistory(world.ctx, historyRequestSchema.parse({ ...baseRequest, mode: 'cohort', offset: 20 }))
    expect(result).toMatchObject({ collections: { admissions: [] }, measures: { admissionCount: 2 }, nextOffset: null, truncated: false })
    expect(world.query).toHaveBeenCalledTimes(2)
  })

  it('propagates source failures and rejects absent or malformed aggregate evidence', async () => {
    for (const aggregates of [[], [{ ...summary }, { ...summary }], [{ ...summary, admissionCount: 'unknown' }], [{ ...summary, admissionCount: -1 }]]) {
      const world = fixture({ summary: aggregates })
      await expect(readHistory(world.ctx, historyRequestSchema.parse(baseRequest))).rejects.toThrow()
    }
    const world = fixture({ admissions: [{ inpatId: '101' }], executions: [{ id: '201' }] })
    world.query.mockRejectedValueOnce(new Error('synthetic unavailable source'))
    await expect(readHistory(world.ctx, historyRequestSchema.parse(baseRequest))).rejects.toThrow('synthetic unavailable source')
    world.query.mockImplementationOnce(async () => [{ data: summary }]).mockRejectedValueOnce(new Error('synthetic missing admission column'))
    await expect(readHistory(world.ctx, historyRequestSchema.parse({ ...baseRequest, mode: 'cohort' }))).rejects.toThrow('synthetic missing admission column')
  })

  it('does not query an already cancelled operation', async () => {
    const world = fixture()
    world.controller.abort()
    await expect(readHistory(world.ctx, historyRequestSchema.parse(baseRequest))).rejects.toThrow()
    expect(world.query).not.toHaveBeenCalled()
  })
})
