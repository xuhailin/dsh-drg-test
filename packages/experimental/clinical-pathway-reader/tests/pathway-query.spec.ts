/** Synthetic query responses exercise bounded assembly; PostgreSQL integration owns SQL execution evidence. */
import { describe, expect, it, vi } from 'vitest'
import { pathwayRequestSchema, type QueryLimits, type ClinicalSourceRow } from '../src/protocol.ts'
import { readPathway } from '../src/pathway-query.ts'
import type { QueryContext } from '../src/query.ts'

type Responses = Record<string, ClinicalSourceRow[][]>
const root: ClinicalSourceRow = { id: '1', pathway_code: 'series-1', version_no: '1.0', state_code: 4, text_truncated: false }
const node = (id: string, pathway = '1', previous: string | null = '0'): ClinicalSourceRow => ({
  id, clinical_pathway_id: pathway, last_node_id: previous, node_name: `Node ${id}`, text_truncated: false,
})
const branch = (id: string, nodeId: string, target: string): ClinicalSourceRow => ({ id, node_id: nodeId, cpid: target })

function fixture(responses: Responses = { definitions: [[root]] }, limits: Partial<QueryLimits> = {}) {
  const controller = new AbortController()
  const requests: { name: string; sql: string; values: readonly (string | number)[] }[] = []
  const query = vi.fn<QueryContext['tx']['query']>(async (sql, values) => {
    const name = /\/\* pathway:(\w+) \*\//.exec(sql)?.[1]
    if (name === undefined) throw new Error('Unrecognized fixture query')
    requests.push({ name, sql, values })
    return (responses[name]?.shift() ?? []).map(data => ({ data }))
  })
  const ctx: QueryContext = {
    tx: { query }, signal: controller.signal,
    scope: { hospitalCode: 'hospital-1', departmentCodes: ['dept-1'], departmentBasis: 'current',
      admissionFrom: '2020-01-01T00:00:00Z', admissionTo: '2027-01-01T00:00:00Z' },
    limits: { maxRows: 200, maxRowBytes: 65536, maxQueryBytes: 1048576, maxTextChars: 4000,
      maxBranchDepth: 3, maxBranches: 5, herbalTables: false, ...limits },
  }
  return { ctx, query, requests, controller }
}

describe('pathway definition queries', () => {
  it('binds all selectors and returns bounded search candidates without reading children', async () => {
    const world = fixture({ definitions: [[root, { id: '2' }, { id: '3' }]] })
    const search = "x'); DROP TABLE cp_clinical_pathway; --"
    const args = pathwayRequestSchema.parse({ search, pathwayCode: 'series-1', versionNo: '1.0', offset: 4, limit: 2 })
    const result = await readPathway(world.ctx, args)
    expect(result.collections.pathways).toEqual([root, { id: '2' }])
    expect(result.nextOffset).toBe(6)
    expect(result.truncated).toBe(true)
    expect(world.requests).toHaveLength(1)
    expect(world.requests[0]!.values.slice(0, 10)).toEqual([
      'hospital-1', '["dept-1"]', 0, '[]', search, 'series-1', '1.0', 3, 4, 4000,
    ])
    expect(world.requests[0]!.sql).not.toContain(search)
    expect(world.requests[0]!.sql).not.toMatch(/SELECT\s+\*/i)
    expect(result.coverage).toContain('Search returns definition candidates only; read a pathwayId to expand its contents.')
  })

  it('returns exact-version components, preserves grouping and orders nodes by predecessor', async () => {
    const world = fixture({
      definitions: [[root], [{ id: '2', pathway_code: 'branch-series', version_no: '2.0' }]],
      departments: [[{ id: '101', clinical_pathway_id: '1', dept_code: 'dept-1' }]],
      diagnoses: [[{ id: '201', clinical_pathway_id: '1', diagnosis_code: 'synthetic' }]],
      assessments: [[{ id: '301', clinical_pathway_id: '1', evaluation_type: 0, evaluation_criteria: 'Synthetic inclusion' }]],
      nodes: [[node('11', '1', '12'), node('12')], [node('22', '2')]],
      items: [[{ id: '401', node_id: '12', item_class_code: '24', item_type: 0, group_sn: 3, group_package_sn: 5 }]],
      branches: [[branch('501', '11', '2')]],
      operations: [[{ id: '601', item_id: '401', operation_code: 'op-1' }]],
      dictionary: [[{ id: '701', item_type: 0, item_code: 'synthetic', dept_code: 'dept-1' }]],
      herbalRecipes: [[{ item_id: '401', order_name: 'Synthetic recipe', drug_count: 2 }]],
      herbalDetails: [[{ id: '801', item_id: '401', sort: 0, once_dose: '2.50', dose_unit_name: 'g' }]],
    }, { herbalTables: true, operationTables: true, dictionaryTables: true })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(result.collections.pathways?.map(row => row.id)).toEqual(['1', '2'])
    expect(result.collections.nodes?.map(row => [row.id, row.sequence])).toEqual([['12', 0], ['11', 1], ['22', 0]])
    expect(result.collections.items?.[0]).toMatchObject({ group_sn: 3, group_package_sn: 5 })
    expect(result.collections.assessments?.[0]?.evaluation_type).toBe(0)
    expect(result.collections.operations?.[0]?.item_id).toBe('401')
    expect(result.collections.herbalDetails?.[0]).toMatchObject({ item_id: '401', once_dose: '2.50', dose_unit_name: 'g' })
    expect(result.measures.rootPathwayId).toBe('1')
    expect(result.measures.branchDefinitionsRequested).toBe(1)
    expect(result.truncated).toBe(false)
    const definitionCalls = world.requests.filter(request => request.name === 'definitions')
    expect(definitionCalls.map(request => request.values[3])).toEqual(['["1"]', '["2"]'])
    for (const request of world.requests) {
      expect(request.values[0]).toBe('hospital-1')
      expect(request.sql).toContain('cur_hospital_code=$1')
      expect(request.sql).not.toMatch(/SELECT\s+\*/i)
      expect(request.values.every(value => typeof value === 'string' || typeof value === 'number')).toBe(true)
    }
    expect(world.requests.find(request => request.name === 'herbalDetails')?.sql).toContain('ORDER BY s.item_id, s.sort, s.id')
    expect(world.requests.find(request => request.name === 'dictionary')?.sql).toContain("string_to_array(d.dept_code, '|')")
  })

  it.each([false, true])('requires an explicit shared-definition grant (%s)', async (includeSharedDefinitions) => {
    const world = fixture({ definitions: [[]] })
    world.ctx.scope.includeSharedDefinitions = includeSharedDefinitions
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(world.requests[0]!.values[2]).toBe(includeSharedDefinitions ? 1 : 0)
    expect(world.requests[0]!.sql).toContain("($3::integer=1 AND d.dept_code='-1')")
    expect(world.requests[0]!.sql).toContain('d.cur_hospital_code=$1')
    expect(result.collections.pathways).toEqual([])
    expect(world.requests).toHaveLength(1)
    expect(result.coverage).toContain('The requested definition is unavailable within the granted scope and selectors.')
  })

  it('retains branch references, detects cycles and expands a shared target only once', async () => {
    const world = fixture({
      definitions: [[root], [{ id: '2' }, { id: '3' }]],
      nodes: [[node('10')], [node('20', '2'), node('30', '3')]],
      branches: [[branch('100', '10', '2'), branch('101', '10', '3'), branch('102', '10', '2')],
        [branch('103', '20', '3'), branch('104', '30', '1')]],
    })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(world.requests.filter(request => request.name === 'definitions')).toHaveLength(2)
    expect(result.collections.branches).toHaveLength(5)
    expect(result.measures.branchDefinitionsRequested).toBe(2)
    expect(result.coverage).toContain('branches: cyclic definition references were detected and not expanded again.')
  })

  it('finishes cycle detection when two branches converge before a later ancestor is reached', async () => {
    const world = fixture({
      definitions: [[root], [{ id: '2' }, { id: '3' }, { id: '6' }], [{ id: '4' }]],
      nodes: [[node('10')], [node('20', '2'), node('30', '3'), node('60', '6')], [node('40', '4')]],
      branches: [[branch('100', '10', '6'), branch('101', '10', '2'), branch('102', '10', '3')],
        [branch('103', '20', '4'), branch('104', '30', '4'), branch('105', '60', '1')]],
    })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(result.collections.pathways?.map(row => row.id)).toEqual(['1', '2', '3', '6', '4'])
    expect(result.measures.branchDefinitionsRequested).toBe(4)
    expect(world.requests.filter(request => request.name === 'definitions')).toHaveLength(3)
    expect(result.coverage).toContain('branches: cyclic definition references were detected and not expanded again.')
  })

  it('rejects a source branch that does not belong to a returned node', async () => {
    const world = fixture({ definitions: [[root]], nodes: [[node('10')]], branches: [[branch('100', '99', '2')]] })
    await expect(readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' })))
      .rejects.toThrow('Source branch does not belong to a returned node.')
    expect(world.requests.filter(request => request.name === 'definitions')).toHaveLength(1)
  })

  it.each([{ maxBranchDepth: 0 }, { maxBranches: 0 }])('reports unexpanded references when the branch bound is %j', async (limit) => {
    const world = fixture({ definitions: [[root]], nodes: [[node('10')]], branches: [[branch('100', '10', '2')]] }, limit)
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(world.requests.filter(request => request.name === 'definitions')).toHaveLength(1)
    expect(result.collections.branches).toHaveLength(1)
    expect(result.truncated).toBe(true)
    expect(result.coverage).toContain('branches: depth or definition-count limit reached; references remain visible without expansion.')
  })

  it('describes a branch definition omitted by its scope without querying that definition’s children', async () => {
    const world = fixture({ definitions: [[root], []], nodes: [[node('10')]], branches: [[branch('100', '10', '2')]] })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(result.collections.pathways).toEqual([root])
    expect(world.requests.filter(request => request.name === 'nodes')).toHaveLength(1)
    expect(result.coverage).toContain('branches: some referenced definitions are unavailable within scope or the remaining row limit.')
  })

  it('applies the row budget to the full collection set and marks skipped children', async () => {
    const world = fixture({ definitions: [[root]], departments: [[{ id: '10' }]], diagnoses: [[{ id: '20' }, { id: '21' }]] }, { maxRows: 3 })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(Object.values(result.collections).flat()).toHaveLength(3)
    expect(result.measures.returnedRows).toBe(3)
    expect(world.requests.map(request => request.name)).toEqual(['definitions', 'departments', 'diagnoses'])
    expect(world.requests[2]!.values[2]).toBe(2)
    expect(result.coverage).toContain('diagnoses: row limit reached; the collection is partial.')
    expect(result.coverage).toContain('nodes: not expanded because the total row limit was reached.')
    expect(result.truncated).toBe(true)
    expect(result.nextOffset).toBeNull()
  })

  it('distinguishes text truncation from search pagination', async () => {
    const world = fixture({ definitions: [[{ ...root, pathway_name: 'partial text', text_truncated: true }]] })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ limit: 1 }))
    expect(result.truncated).toBe(true)
    expect(result.nextOffset).toBeNull()
    expect(result.coverage).toContain('pathways: source text exceeds the configured character limit.')
  })

  it('preserves unresolved or ambiguous predecessor records and reports ordering limitations', async () => {
    const world = fixture({ definitions: [[root]], nodes: [[
      node('10', '1', '11'), node('11', '1', '10'), node('20', '1', '99'), node('21', '1', '20'), node('22', '1', '20'),
    ]] })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(result.collections.nodes?.map(row => row.id)).toEqual(['20', '21', '22', '10', '11'])
    expect(result.collections.nodes?.filter(row => row.sequence === null).map(row => row.id)).toEqual(['10', '11'])
    expect(result.coverage).toContain('nodes: a predecessor was not returned; ordering is partial.')
    expect(result.coverage).toContain('nodes: multiple successors share a predecessor; source order is ambiguous.')
    expect(result.coverage).toContain('nodes: cyclic predecessors cannot be ordered; unresolved nodes retain their source references.')
  })

  it('orders a null-predecessor root and emits each source node identity once', async () => {
    const world = fixture({ definitions: [[root]], nodes: [[node('10', '1', null), node('11', '1', '10'), node('11', '1', '10')]] })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(result.collections.nodes?.map(row => [row.id, row.sequence])).toEqual([['10', 0], ['11', 1]])
    expect(result.coverage).toContain('nodes: multiple successors share a predecessor; source order is ambiguous.')
  })

  it('keeps an enabled empty dictionary explicit and distinguishes it from a disabled source', async () => {
    const world = fixture({ definitions: [[root]], nodes: [[node('10')]],
      items: [[{ id: '20', node_id: '10', item_class_code: '99' }]], dictionary: [[]],
    }, { dictionaryTables: true })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(result.collections.dictionary).toEqual([])
    expect(result.collections.drugParameters).toEqual([])
    expect(world.requests.some(request => request.name === 'dictionary')).toBe(true)
    expect(result.coverage).not.toContain('dictionary: optional source is not enabled.')
  })

  it('reads current drug parameters once for distinct returned order codes and preserves ambiguous matches', async () => {
    const code = "DRUG'); SELECT 1; --"
    const first = { cur_hospital_code: 'hospital-1', drug_code: code, base_dose: '0', base_dose1: '1.25',
      base_unit_name1: 'Synthetic unit', skin_test_flag: false }
    const second = { ...first, base_dose1: '2.50' }
    const world = fixture({ definitions: [[root], [{ id: '2' }]], nodes: [[node('10')], [node('11', '2')]],
      items: [[{ id: '20', node_id: '10', item_type: 0, item_code: code }],
        [{ id: '21', node_id: '11', item_type: 0, item_code: code },
          { id: '22', node_id: '11', item_type: 1, item_code: 'WORK-NOT-DRUG' }]],
      branches: [[branch('30', '10', '2')]], drugParameters: [[first, second]],
    }, { dictionaryTables: true })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    const calls = world.requests.filter(request => request.name === 'drugParameters')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.values.slice(0, 2)).toEqual(['hospital-1', JSON.stringify([code])])
    expect(calls[0]?.sql).toContain('FROM v_cpoe_drug d')
    expect(calls[0]?.sql).toContain('d.cur_hospital_code=$1')
    expect(calls[0]?.sql).toContain('d.base_dose::text')
    expect(calls[0]?.sql).not.toContain(code)
    expect(calls[0]?.sql).not.toMatch(/is_deleted|\bstate\b|SELECT\s+\*/i)
    expect(result.collections.drugParameters).toEqual([first, second])
    expect(result.coverage.join('\n')).toContain('missing or duplicate matches')
  })

  it.each([3, 4])('applies the remaining complete-result row budget to drug parameters: maxRows=%s', async (maxRows) => {
    const world = fixture({ definitions: [[root]], nodes: [[node('10')]],
      items: [[{ id: '20', node_id: '10', item_type: 0, item_code: 'DRUG' }]],
      drugParameters: [[{ drug_code: 'DRUG', base_dose: '0' }, { drug_code: 'DRUG', base_dose: '1' }]],
    }, { dictionaryTables: true, maxRows })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(Object.values(result.collections).flat()).toHaveLength(maxRows)
    expect(result.measures.returnedRows).toBe(maxRows)
    expect(result.truncated).toBe(true)
    if (maxRows === 3) {
      expect(world.requests.some(request => request.name === 'drugParameters')).toBe(false)
      expect(result.coverage).toContain('drugParameters: not expanded because the total row limit was reached.')
    } else {
      expect(result.collections.drugParameters).toHaveLength(1)
      expect(result.coverage).toContain('drugParameters: row limit reached; the collection is partial.')
    }
  })

  it('retains clipped drug parameter text with explicit incomplete coverage', async () => {
    const world = fixture({ definitions: [[root]], nodes: [[node('10')]],
      items: [[{ id: '20', node_id: '10', item_type: 0, item_code: 'DRUG' }]],
      drugParameters: [[{ drug_code: 'DRUG', base_unit_name1: 'Clipped', text_truncated: true }]],
    }, { dictionaryTables: true })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(result.truncated).toBe(true)
    expect(result.coverage).toContain('drugParameters: source text exceeds the configured character limit.')
    expect(result.collections.drugParameters?.[0]?.base_unit_name1).toBe('Clipped')
  })

  it('returns an empty later search page without claiming another page exists', async () => {
    const world = fixture({ definitions: [[]] })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ offset: 20, limit: 3 }))
    expect(result).toMatchObject({ collections: { pathways: [] }, nextOffset: null, truncated: false, measures: { returnedRows: 0 } })
    expect(world.requests).toHaveLength(1)
    expect(world.requests[0]?.values[8]).toBe(20)
  })

  it('reports disabled optional sources without querying them', async () => {
    const world = fixture({ definitions: [[root]], nodes: [[node('10')]], items: [[{ id: '20', node_id: '10', item_class_code: '24' }]] })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(world.requests.some(request => ['operations', 'dictionary', 'drugParameters', 'herbalRecipes', 'herbalDetails'].includes(request.name))).toBe(false)
    expect(result.coverage).toContain('operations: optional source is not enabled.')
    expect(result.coverage).toContain('dictionary: optional source is not enabled.')
    expect(result.coverage).toContain('drugParameters: optional source is not enabled.')
    expect(result.coverage).toContain('herbalRecipes/herbalDetails: optional sources are not enabled.')
  })

  it('reports herbal items with no returned recipe without inventing an empty prescription', async () => {
    const world = fixture({ definitions: [[root]], nodes: [[node('10')]], items: [[{ id: '20', node_id: '10', item_class_code: '24' }]] }, { herbalTables: true })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(result.collections.herbalRecipes).toEqual([])
    expect(result.coverage).toContain('herbalRecipes: at least one returned herbal item has no returned recipe; coverage is incomplete.')
  })

  it('reports recipes whose ingredient records are absent', async () => {
    const world = fixture({ definitions: [[root]], nodes: [[node('10')]],
      items: [[{ id: '20', node_id: '10', item_class_code: '24' }]], herbalRecipes: [[{ item_id: '20' }]],
    }, { herbalTables: true })
    const result = await readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))
    expect(result.collections.herbalDetails).toEqual([])
    expect(result.coverage).toContain('herbalDetails: at least one returned recipe has no returned ingredients; coverage is incomplete.')
  })

  it.each(['diagnoses', 'herbalRecipes'])('propagates a required or enabled-source failure from %s', async (failing) => {
    const world = fixture({ definitions: [[root]], nodes: [[node('10')]], items: [[{ id: '20', node_id: '10', item_class_code: '24' }]] }, { herbalTables: true })
    const original = world.query.getMockImplementation()!
    const failure = new Error('Synthetic source missing')
    world.query.mockImplementation((sql, values) => {
      if (sql.includes(`/* pathway:${failing} */`)) throw failure
      return original(sql, values)
    })
    await expect(readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))).rejects.toBe(failure)
  })

  it('rejects malformed source identifiers before using them in child queries', async () => {
    const world = fixture({ definitions: [[{ id: 'not-an-id' }]] })
    await expect(readPathway(world.ctx, pathwayRequestSchema.parse({ pathwayId: '1' }))).rejects.toThrow()
    expect(world.requests).toHaveLength(1)
  })

  it('stops before a cancelled query and discards a result cancelled during the read', async () => {
    const before = fixture()
    before.controller.abort()
    await expect(readPathway(before.ctx, pathwayRequestSchema.parse({}))).rejects.toThrow()
    expect(before.query).not.toHaveBeenCalled()
    const during = fixture()
    during.query.mockImplementation(async () => { during.controller.abort(); return [{ data: root }] })
    await expect(readPathway(during.ctx, pathwayRequestSchema.parse({}))).rejects.toThrow()
    expect(during.query).toHaveBeenCalledTimes(1)
  })
})
