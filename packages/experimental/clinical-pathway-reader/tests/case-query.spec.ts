import { describe, expect, it, vi } from 'vitest'
import type { ReadTransaction } from '@deepseek-ai/dsh-experimental-emr-reader-broker'
import { readCase } from '../src/case-query.ts'
import { caseRequestSchema, type ReadScope, type ClinicalSourceRow } from '../src/protocol.ts'
import type { QueryContext } from '../src/query.ts'

function fixture(scope: Partial<ReadScope> = {}) {
  const query = vi.fn<ReadTransaction['query']>()
  const controller = new AbortController()
  const ctx: QueryContext = {
    tx: { query }, signal: controller.signal,
    scope: { hospitalCode: 'hospital-a', departmentCodes: ['dept-a'], departmentBasis: 'discharge',
      admissionFrom: '2025-01-01T00:00:00Z', admissionTo: '2026-01-01T00:00:00Z', ...scope },
    limits: { maxRows: 2, maxTextChars: 6, maxBranchDepth: 4, maxBranches: 10, herbalTables: false,
      maxRowBytes: 65536, maxQueryBytes: 1048576 },
  }
  query.mockResolvedValueOnce([{ data: { inpatId: '10', stateCode: '6', outTime: '2025-04-01T10:00:00Z' } }])
  return { query, controller, ctx }
}

function document(overrides: ClinicalSourceRow = {}): ClinicalSourceRow {
  return { id: '20:30', recordId: '20', contentId: '30', readable: true, totalChars: 12,
    start: 0, length: 6, text: null, nextStart: null, ...overrides }
}

describe('case evidence queries', () => {
  it('returns a discharged encounter without adding an inpatient-only restriction', async () => {
    const world = fixture()
    const result = await readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'encounter' }))
    expect(result.collections.encounter).toEqual([{ inpatId: '10', stateCode: '6', outTime: '2025-04-01T10:00:00Z' }])
    const [sql, values] = world.query.mock.calls[0]!
    expect(sql).toContain('p.out_dept_code IN')
    expect(sql).toContain('p.is_valid=true')
    expect(sql).toContain('p.in_time >= $3::timestamptz AND p.in_time < $4::timestamptz')
    expect(sql).not.toContain("IN ('4', '5')")
    expect(values.slice(0, 5)).toEqual(['hospital-a', '["dept-a"]', '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '10'])
    expect(result.coverage).toContain('administration:unsupported')
    expect(result.coverage).toContain('labs:unsupported')
  })

  it('returns an empty later encounter page after verifying the encounter remains authorized', async () => {
    const world = fixture()
    const result = await readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'encounter', offset: 1 }))
    expect(result.collections.encounter).toEqual([])
    expect(result.coverage).toContain('encounter:empty-page')
    expect(result.coverage).not.toContain('encounter:complete')
    expect(result.nextOffset).toBeNull()
    expect(result.truncated).toBe(false)
    expect(world.query).toHaveBeenCalledTimes(1)
  })

  it('stops before clinical reads when no encounter matches the scope', async () => {
    const world = fixture()
    world.query.mockReset().mockResolvedValueOnce([])
    await expect(readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'documents', recordId: '20' })))
      .rejects.toMatchObject({ code: 'not-found' })
    expect(world.query).toHaveBeenCalledTimes(1)
  })

  it('rejects nonunique admission identity instead of accepting one matching row', async () => {
    const world = fixture()
    world.query.mockReset().mockResolvedValueOnce([{ data: { inpatId: '10' } }, { data: { inpatId: '10' } }])
    await expect(readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'orders' })))
      .rejects.toMatchObject({ code: 'source-mismatch' })
    expect(world.query).toHaveBeenCalledTimes(1)
  })

  it('pages diagnoses without dropping deleted, suspected or noncurrent source states', async () => {
    const world = fixture({ departmentBasis: 'current', departmentCodes: ["dept' OR true --"] })
    const source = [{ id: '1', isDeleted: true }, { id: '2', isSuspected: true, isCurrent: false }]
    world.query.mockResolvedValueOnce([...source, { id: '3' }].map(data => ({ data })))
    const result = await readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'diagnoses', limit: 80, offset: 4 }))
    expect(result.collections.diagnoses).toEqual(source)
    expect(result.nextOffset).toBe(6)
    expect(result.truncated).toBe(true)
    const [sql, values] = world.query.mock.calls[1]!
    expect(sql).toContain('p.current_dept_code IN')
    expect(sql).toContain('p.cur_hospital_code=d.cur_hospital_code')
    expect(sql).toContain('d.inpat_id=$5::bigint AND d.cur_hospital_code=$1')
    expect(sql).not.toContain("dept' OR true --")
    expect(values.slice(0, 7)).toEqual(['hospital-a', '["dept\' OR true --"]', '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '10', 3, 4])
  })

  it('preserves order timing and state without declaring actual execution coverage', async () => {
    const world = fixture()
    const order = { id: '40', stateId: 14, isDeleted: true, execNum: 1, execTime: '2025-01-02 08:00:00', availableAt: null }
    world.query.mockResolvedValueOnce([{ data: order }])
    const result = await readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'orders' }))
    expect(result.collections.orders).toEqual([order])
    expect(result.coverage).toContain('orders:execution-details-unsupported')
    expect(result.coverage).toContain('orders:availability-time-unknown')
    expect(world.query.mock.calls[1]![0]).toContain('p.cur_hospital_code=o.cur_hospital_code')
  })

  it('keeps document content identities and marks missing text without treating the document as absent', async () => {
    const world = fixture()
    const records = [document({ fileVersion: '9' }), document({ id: '20:31', contentId: '31', fileVersion: '10', readable: false, totalChars: 0 })]
    world.query.mockResolvedValueOnce(records.map(data => ({ data })))
    const result = await readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'documents' }))
    expect(result.collections.documents).toEqual(records)
    expect(result.coverage).toContain('documents:unreadable-text')
    expect(result.coverage).toContain('documents:text-not-requested')
    expect(result.coverage).toContain('documents:object-files-and-forms-unsupported')
    expect(result.nextOffset).toBeNull()
    const [sql, values] = world.query.mock.calls[1]!
    expect(sql).toContain('LEFT JOIN cpoe_inpat_medical_record_content c ON c.record_id=r.id')
    expect(sql).toContain('ORDER BY r.id,c.id NULLS FIRST')
    expect(sql).not.toMatch(/ORDER BY[^\n]*file_version/)
    expect(values.slice(7, 11)).toEqual(['', '', 0, 6])
  })

  it('bounds passages in SQL and returns row and text continuations independently', async () => {
    const world = fixture()
    world.query.mockResolvedValueOnce([
      { data: document({ text: '第一个片段文', nextStart: 10, start: 4 }) },
      { data: document({ id: '20:31', contentId: '31', text: '第二个片段文', nextStart: 10, start: 4 }) },
      { data: document({ id: '20:32', contentId: '32' }) },
    ])
    const result = await readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'documents', recordId: '20', start: 4, length: 100, offset: 2 }))
    expect(result.collections.documents).toHaveLength(2)
    expect(result.collections.documents![0]!.nextStart).toBe(10)
    expect(result.nextOffset).toBe(4)
    expect(result.truncated).toBe(true)
    expect(result.coverage).toContain('documents:partial-text')
    const [sql, values] = world.query.mock.calls[1]!
    expect(sql).toContain('substring(c.record_text FROM $10::integer+1 FOR $11::integer)')
    expect(sql).toContain("r.id=NULLIF($8,'')::bigint")
    expect(sql).toContain("c.id=NULLIF($9,'')::bigint")
    expect(values.slice(7, 11)).toEqual(['20', '', 4, 6])
  })

  it('reports text continuation even when all document rows fit on one page', async () => {
    const world = fixture()
    world.query.mockResolvedValueOnce([{ data: document({ text: 'abcdef', nextStart: 6 }) }])
    const result = await readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'documents', recordId: '20', contentId: '30' }))
    expect(result.truncated).toBe(true)
    expect(result.nextOffset).toBeNull()
    expect(world.query.mock.calls[1]![1].slice(7, 9)).toEqual(['20', '30'])
  })

  it('retains a document with no content row as unreadable metadata', async () => {
    const world = fixture()
    const missing = document({ id: '20:missing', contentId: null, readable: false, totalChars: null })
    world.query.mockResolvedValueOnce([{ data: missing }])
    const result = await readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'documents', recordId: '20' }))
    expect(result.collections.documents).toEqual([missing])
    expect(result.coverage).toContain('documents:unreadable-text')
    expect(result.coverage).not.toContain('documents:empty-page')
    expect(result.truncated).toBe(false)
  })

  it('rejects oversized source metadata without returning partial clinical evidence', async () => {
    const world = fixture()
    world.query.mockResolvedValueOnce([{ data: { id: '1' } }, { data: null }])
    await expect(readCase(world.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'diagnoses' })))
      .rejects.toMatchObject({ code: 'limit-exceeded' })
    const values = world.query.mock.calls[1]![1]
    expect(values.slice(-3)).toEqual([65536, 1048576, 3])
  })

  it('reports a successful empty page separately from query failure and cancellation', async () => {
    const empty = fixture()
    empty.query.mockResolvedValueOnce([])
    const result = await readCase(empty.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'diagnoses' }))
    expect(result.coverage).toContain('diagnoses:empty-page')
    const failed = fixture()
    const error = new Error('synthetic source failure')
    failed.query.mockRejectedValueOnce(error)
    await expect(readCase(failed.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'orders' }))).rejects.toBe(error)
    const cancelled = fixture()
    cancelled.controller.abort()
    await expect(readCase(cancelled.ctx, caseRequestSchema.parse({ inpatId: '10', category: 'encounter' }))).rejects.toThrow()
    expect(cancelled.query).not.toHaveBeenCalled()
  })
})
