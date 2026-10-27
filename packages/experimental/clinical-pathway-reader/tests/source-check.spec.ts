import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ReadTransaction } from '@deepseek-ai/dsh-experimental-emr-reader-broker'
import type { QueryLimits } from '../src/protocol.ts'
import { verifySource } from '../src/source-check.ts'

function fixture(overrides: Partial<QueryLimits> = {}) {
  const limits: QueryLimits = { maxRows: 20, maxRowBytes: 65536, maxQueryBytes: 1048576, maxTextChars: 4000,
    maxBranchDepth: 4, maxBranches: 10, herbalTables: false, ...overrides }
  const state = { schema: 'clinical', read_only: 'on', time_zone: 'UTC', has_temp_schema: false, unsafe_role: false }
  const query = vi.fn<ReadTransaction['query']>(async (sql, values) => {
    if (sql.startsWith('SELECT set_config')) return [{ set_config: values[0] }]
    if (sql.includes('current_schema()')) return [state]
    if (sql.includes('has_table_privilege')) {
      const names = z.array(z.string()).parse(JSON.parse(String(values[1])))
      return names.map(table_name => ({ table_name, readable: true, writable: false, owned: false, schema_owned: false }))
    }
    return []
  })
  return { limits, state, query, tx: { query } }
}

describe('read-only clinical source verification', () => {
  it('checks the exact schema, role, table privileges and required columns without reading clinical rows', async () => {
    const world = fixture()
    await expect(verifySource(world.tx, 'clinical', world.limits)).resolves.toBe('UTC')
    expect(world.query).toHaveBeenCalledTimes(4)
    expect(world.query.mock.calls[0]).toEqual(["SELECT set_config('search_path',$1,true)", ['clinical']])
    expect(world.query.mock.calls[2]![0]).toContain("has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')")
    const columnsCall = world.query.mock.calls[3]!
    expect(columnsCall[0]).toContain('information_schema.columns')
    expect(columnsCall[1][0]).toBe('clinical')
    const columns = z.array(z.object({ table_name: z.string(), column_name: z.string() })).parse(JSON.parse(String(columnsCall[1][1])))
    expect(columns).toContainEqual({ table_name: 'cpoe_inpat_medical_record_content', column_name: 'record_text' })
    expect(columns).toContainEqual({ table_name: 'cpoe_inpat_order', column_name: 'cp_source_project_id' })
    expect(columns.some(column => column.table_name === 'cp_clinical_pathway_node_execution_records')).toBe(false)
    expect(world.query.mock.calls.every(([sql]) => !/FROM\s+(?:cpoe_|cp_clinical_)/i.test(sql))).toBe(true)
  })

  it.each(['clinical, public', 'clinical; DROP TABLE x', 'Clinical', '', 'a'.repeat(64), 'clinical\n'])('rejects invalid schema identifier %j before SQL', async (schema) => {
    const world = fixture()
    await expect(verifySource(world.tx, schema, world.limits)).rejects.toMatchObject({ code: 'source-unavailable' })
    expect(world.query).not.toHaveBeenCalled()
  })

  describe.each([false, true])('source requirements with allowWritableDevelopmentRole=%s', (allowWritableDevelopmentRole) => {
    it.each([
      { schema: 'other' }, { schema: null }, { read_only: 'off' }, { has_temp_schema: true }, { unsafe_role: true },
    ])('rejects unsafe transaction state %j before checking source tables', async (state) => {
      const world = fixture({ allowWritableDevelopmentRole })
      Object.assign(world.state, state)
      await expect(verifySource(world.tx, 'clinical', world.limits)).rejects.toMatchObject({ code: 'source-unavailable' })
      expect(world.query).toHaveBeenCalledTimes(2)
    })

    it('rejects a missing or unreadable source table', async () => {
      const world = fixture({ allowWritableDevelopmentRole })
      const validQuery = world.query.getMockImplementation()!
      world.query.mockImplementation(async (sql, values) => {
        const result = await validQuery(sql, values)
        return sql.includes('has_table_privilege') ? result.map(row => ({ ...z.record(z.string(), z.json()).parse(row), readable: false })) : result
      })
      await expect(verifySource(world.tx, 'clinical', world.limits)).rejects.toMatchObject({ code: 'source-unavailable' })
      expect(world.query).toHaveBeenCalledTimes(3)
    })

    it('rejects a missing required physical column', async () => {
      const world = fixture({ allowWritableDevelopmentRole })
      const validQuery = world.query.getMockImplementation()!
      world.query.mockImplementation((sql, values) => sql.includes('information_schema.columns')
        ? Promise.resolve([{ table_name: 'cpoe_inpat_order', column_name: 'cp_exec_id' }]) : validQuery(sql, values))
      await expect(verifySource(world.tx, 'clinical', world.limits)).rejects.toMatchObject({ code: 'source-unavailable' })
    })
  })

  it.each(['writable', 'owned', 'schema_owned'])('rejects %s privilege even in a read-only transaction', async (field) => {
    const world = fixture()
    const validQuery = world.query.getMockImplementation()!
    world.query.mockImplementation(async (sql, values) => {
      const result = await validQuery(sql, values)
      return sql.includes('has_table_privilege') ? result.map((row, index) => index === 0 ? { ...z.record(z.string(), z.json()).parse(row), [field]: true } : row) : result
    })
    await expect(verifySource(world.tx, 'clinical', world.limits)).rejects.toMatchObject({ code: 'source-unavailable' })
    expect(world.query).toHaveBeenCalledTimes(3)
  })

  it.each(['writable', 'owned', 'schema_owned'])('allows %s privilege only under explicit development policy', async (field) => {
    const world = fixture({ allowWritableDevelopmentRole: true })
    const validQuery = world.query.getMockImplementation()!
    world.query.mockImplementation(async (sql, values) => {
      const result = await validQuery(sql, values)
      return sql.includes('has_table_privilege') ? result.map((row, index) => index === 0 ? { ...z.record(z.string(), z.json()).parse(row), [field]: true } : row) : result
    })
    await expect(verifySource(world.tx, 'clinical', world.limits)).resolves.toBe('UTC')
    expect(world.query).toHaveBeenCalledTimes(4)
    world.query.mockClear()
    world.limits.allowWritableDevelopmentRole = false
    await expect(verifySource(world.tx, 'clinical', world.limits)).rejects.toMatchObject({ code: 'source-unavailable' })
    expect(world.query).toHaveBeenCalledTimes(3)
  })

  it.each([
    [{}, []],
    [{ herbalTables: true }, ['cp_herbal_recipe', 'cp_herbal_recipe_detail']],
    [{ operationTables: true }, ['cp_clinical_pathway_item_operation']],
    [{ dictionaryTables: true }, ['cp_clinical_pathway_item_dic', 'v_cpoe_drug']],
  ] satisfies [Partial<QueryLimits>, string[]][])('checks optional families only when enabled: %j', async (flags, enabled) => {
    const world = fixture(flags)
    await verifySource(world.tx, 'clinical', world.limits)
    const names = z.array(z.string()).parse(JSON.parse(String(world.query.mock.calls[2]![1][1])))
    const optional = ['cp_herbal_recipe', 'cp_herbal_recipe_detail', 'cp_clinical_pathway_item_operation', 'cp_clinical_pathway_item_dic', 'v_cpoe_drug']
    expect(names.filter(name => optional.includes(name))).toEqual(enabled)
  })

  it('admits the enabled known drug view and requires hospital, code and every enrichment field', async () => {
    const world = fixture({ dictionaryTables: true })
    await verifySource(world.tx, 'clinical', world.limits)
    const privileges = world.query.mock.calls[2]!
    expect(privileges[0]).toContain("expected.table_name='v_cpoe_drug' AND c.relkind='v'")
    const columns = z.array(z.object({ table_name: z.string(), column_name: z.string() }))
      .parse(JSON.parse(String(world.query.mock.calls[3]![1][1])))
    expect(columns.filter(row => row.table_name === 'v_cpoe_drug').map(row => row.column_name)).toEqual([
      'cur_hospital_code', 'drug_code', 'base_dose', 'base_dose1', 'base_unit_name1', 'skin_test_flag',
    ])
    const valid = world.query.getMockImplementation()!
    world.query.mockImplementation((sql, values) => sql.includes('information_schema.columns')
      ? Promise.resolve([{ table_name: 'v_cpoe_drug', column_name: 'cur_hospital_code' }]) : valid(sql, values))
    await expect(verifySource(world.tx, 'clinical', world.limits)).rejects.toMatchObject({ code: 'source-unavailable' })
  })

  it('checks again on a later transaction and exposes only a safe source failure', async () => {
    const world = fixture()
    await verifySource(world.tx, 'clinical', world.limits)
    world.query.mockClear()
    world.query.mockRejectedValueOnce(new Error('synthetic internal connection detail'))
    await expect(verifySource(world.tx, 'clinical', world.limits)).rejects.toMatchObject({
      code: 'source-unavailable', message: 'Clinical source checks failed. Ask the operator to verify the source schema, required columns and read-only transaction/role policy.',
    })
    expect(world.query).toHaveBeenCalledTimes(1)
  })
})
