/** Fixed, scoped definition queries preserve version identity and bounded child collections. */
import { z } from 'zod'
import type { PathwayRequest, QueryResult, ClinicalSourceRow } from './protocol.ts'
import { emptyResult, rows, type QueryContext } from './query.ts'

interface Column { name: string; kind?: 'id' | 'text' | 'decimal' }

// These identifiers belong to the source mapping; request values only enter query parameters.
function projection(alias: string, columns: readonly Column[], textParameter: string): string {
  const entries = columns.flatMap((column) => {
    const value = `${alias}.${column.name}`
    const expression = column.kind === 'text' ? `left(${value}, ${textParameter}::integer)`
      : column.kind === 'id' || column.kind === 'decimal' ? `${value}::text` : value
    return [`'${column.name}'`, expression]
  })
  const clipped = columns.filter(column => column.kind === 'text')
    .map(column => `coalesce(length(${alias}.${column.name}), 0) > ${textParameter}::integer`)
  entries.push("'text_truncated'", `(${clipped.join(' OR ')})`)
  // PostgreSQL variadic functions accept at most 100 arguments.
  const chunks: string[] = []
  for (let index = 0; index < entries.length; index += 100) chunks.push(`jsonb_build_object(${entries.slice(index, index + 100).join(', ')})`)
  return chunks.join(' || ')
}

const definitionColumns: readonly Column[] = [
  { name: 'id', kind: 'id' }, { name: 'pathway_code' }, { name: 'pathway_name', kind: 'text' },
  { name: 'version_no', kind: 'decimal' }, { name: 'state_code' }, { name: 'cur_hospital_code' },
  { name: 'dept_code' }, { name: 'dept_name', kind: 'text' }, { name: 'days_lower_limit' },
  { name: 'days_upper_limit' }, { name: 'fee_lower_limit', kind: 'decimal' }, { name: 'fee_upper_limit', kind: 'decimal' },
  { name: 'is_deleted' }, { name: 'is_branch_path' }, { name: 'is_treatment_package' }, { name: 'oper_time' },
]
const definitionSql = `/* pathway:definitions */
SELECT ${projection('p', definitionColumns, '$10')} AS data
FROM cp_clinical_pathway p
WHERE p.cur_hospital_code=$1 AND p.is_deleted IS NOT TRUE
  AND (p.dept_code IN (SELECT jsonb_array_elements_text($2::jsonb)) OR EXISTS (
    SELECT 1 FROM cp_clinical_pathway_dept d
    WHERE d.clinical_pathway_id=p.id AND d.cur_hospital_code=$1
      AND (d.dept_code IN (SELECT jsonb_array_elements_text($2::jsonb)) OR ($3::integer=1 AND d.dept_code='-1'))))
  AND ($4='[]' OR p.id::text IN (SELECT jsonb_array_elements_text($4::jsonb)))
  AND ($5='' OR position(lower($5) in lower(p.pathway_name)) > 0)
  AND ($6='' OR p.pathway_code=$6) AND ($7='' OR p.version_no::text=$7)
ORDER BY p.id LIMIT $8::integer OFFSET $9::integer`

interface ChildQuery { sql: string }
function childQuery(name: string, table: string, parentColumn: string, columns: readonly Column[], order = 's.id'): ChildQuery {
  return { sql: `/* pathway:${name} */
SELECT ${projection('s', columns, '$4')} AS data FROM ${table} s
WHERE s.cur_hospital_code=$1 AND s.${parentColumn}::text IN (SELECT jsonb_array_elements_text($2::jsonb))
ORDER BY ${order} LIMIT $3::integer` }
}
const childQueries = {
  departments: childQuery('departments', 'cp_clinical_pathway_dept', 'clinical_pathway_id', [
    { name: 'id', kind: 'id' }, { name: 'clinical_pathway_id', kind: 'id' }, { name: 'dept_code' },
    { name: 'dept_name', kind: 'text' }, { name: 'cur_hospital_code' },
  ]),
  diagnoses: childQuery('diagnoses', 'cp_clinical_pathway_diagnostic_groups', 'clinical_pathway_id', [
    { name: 'id', kind: 'id' }, { name: 'clinical_pathway_id', kind: 'id' }, { name: 'diagnosis_code' },
    { name: 'diagnosis_name', kind: 'text' }, { name: 'copy_id', kind: 'id' },
  ]),
  assessments: childQuery('assessments', 'cp_clinical_pathway_evaluate', 'clinical_pathway_id', [
    { name: 'id', kind: 'id' }, { name: 'clinical_pathway_id', kind: 'id' },
    { name: 'evaluation_criteria', kind: 'text' }, { name: 'evaluation_type' }, { name: 'is_required' },
    { name: 'basis_kind' }, { name: 'basis_kind_name', kind: 'text' },
  ]),
  nodes: childQuery('nodes', 'cp_clinical_pathway_node', 'clinical_pathway_id', [
    { name: 'id', kind: 'id' }, { name: 'clinical_pathway_id', kind: 'id' }, { name: 'last_node_id', kind: 'id' },
    { name: 'node_attribute' }, { name: 'node_name', kind: 'text' }, { name: 'clinical_properties', kind: 'text' },
    { name: 'days_lower_limit' }, { name: 'days_upper_limit' }, { name: 'is_exist_branch_path' }, { name: 'branch_path_id', kind: 'id' },
  ]),
  branches: childQuery('branches', 'cp_branch_path', 'node_id', [
    { name: 'id', kind: 'id' }, { name: 'node_id', kind: 'id' }, { name: 'cpid', kind: 'id' },
    { name: 'clinical_properties', kind: 'text' }, { name: 'cur_hospital_code' },
  ]),
  items: childQuery('items', 'cp_clinical_pathway_item', 'node_id', [
    { name: 'id', kind: 'id' }, { name: 'node_id', kind: 'id' }, { name: 'item_type' }, { name: 'item_code' },
    { name: 'item_name', kind: 'text' }, { name: 'item_class_code' }, { name: 'item_class_name', kind: 'text' },
    { name: 'item_sub_class_code' }, { name: 'item_sub_class_name', kind: 'text' }, { name: 'order_type_code' },
    { name: 'drug_id', kind: 'id' }, { name: 'once_dose' }, { name: 'dose_unit' }, { name: 'frequency_code' },
    { name: 'frequency_name', kind: 'text' }, { name: 'usage_code' }, { name: 'usage_name', kind: 'text' },
    { name: 'usage_type_code' }, { name: 'usage_type_name', kind: 'text' }, { name: 'days' }, { name: 'specs', kind: 'text' },
    { name: 'base_unit_name' }, { name: 'min_unit_name' }, { name: 'pack_unit_name' },
    { name: 'exec_dept_code' }, { name: 'exec_dept_name', kind: 'text' }, { name: 'is_required' },
    { name: 'is_repeatable' }, { name: 'is_multiple_choice' }, { name: 'is_once_dose_change' }, { name: 'is_apply_order' },
    { name: 'group_code' }, { name: 'operation_apply_id', kind: 'id' }, { name: 'template_code' },
    { name: 'remark', kind: 'text' }, { name: 'group_sign' }, { name: 'group_flag' }, { name: 'group_sn' },
    { name: 'group_package_flag' }, { name: 'group_package_sn' }, { name: 'group_sort' }, { name: 'test_is_group' }, { name: 'is_self' },
  ], 's.node_id, s.group_sign, s.group_sort, s.id'),
  operations: childQuery('operations', 'cp_clinical_pathway_item_operation', 'item_id', [
    { name: 'id', kind: 'id' }, { name: 'item_id', kind: 'id' }, { name: 'operation_code' },
    { name: 'operation_name', kind: 'text' }, { name: 'operation_code2' }, { name: 'cur_hospital_code' },
  ]),
  herbalRecipes: childQuery('herbalRecipes', 'cp_herbal_recipe', 'item_id', [
    { name: 'item_id', kind: 'id' }, { name: 'cur_hospital_code' }, { name: 'order_name', kind: 'text' },
    { name: 'order_type_code' }, { name: 'exec_dept_code' }, { name: 'exec_dept_name', kind: 'text' },
    { name: 'drug_count' }, { name: 'decoct_count' }, { name: 'usage_code' }, { name: 'usage_name', kind: 'text' },
    { name: 'usage_code2' }, { name: 'usage_name2', kind: 'text' }, { name: 'frequency_code' },
    { name: 'frequency_name', kind: 'text' }, { name: 'decoction_code' }, { name: 'decoction_name', kind: 'text' },
    { name: 'rules_treatment_name', kind: 'text' }, { name: 'note', kind: 'text' }, { name: 'special_usage_code' },
    { name: 'special_usage_name', kind: 'text' }, { name: 'is_decoction' }, { name: 'is_prescription' },
    { name: 'is_out_pat' }, { name: 'herb_type_code' }, { name: 'decoction_dosage', kind: 'decimal' },
    { name: 'decoction_times' }, { name: 'rate_code' }, { name: 'rate_name', kind: 'text' },
  ], 's.item_id'),
  herbalDetails: childQuery('herbalDetails', 'cp_herbal_recipe_detail', 'item_id', [
    { name: 'id', kind: 'id' }, { name: 'item_id', kind: 'id' }, { name: 'sort' }, { name: 'cur_hospital_code' },
    { name: 'drug_id', kind: 'id' }, { name: 'drug_code' }, { name: 'drug_name', kind: 'text' },
    { name: 'order_sub_class_code' }, { name: 'order_sub_class_name', kind: 'text' }, { name: 'specs', kind: 'text' },
    { name: 'qty', kind: 'decimal' }, { name: 'once_dose', kind: 'decimal' }, { name: 'dose_unit_code' },
    { name: 'dose_unit_name' }, { name: 'dosage_code' }, { name: 'dosage_name', kind: 'text' },
    { name: 'base_dose', kind: 'decimal' }, { name: 'base_unit_code' }, { name: 'base_unit_name' },
    { name: 'send_unit_code' }, { name: 'send_unit_name' }, { name: 'send_pack_qty', kind: 'decimal' },
    { name: 'usage_code' }, { name: 'usage_name', kind: 'text' }, { name: 'usage_code2' }, { name: 'usage_name2', kind: 'text' },
    { name: 'min_unit_code' }, { name: 'min_unit_name' }, { name: 'pack_unit_code' }, { name: 'pack_unit_name' },
    { name: 'pack_qty', kind: 'decimal' }, { name: 'unit_sort' }, { name: 'note', kind: 'text' }, { name: 'herb_type_code' },
  ], 's.item_id, s.sort, s.id'),
} satisfies Record<string, ChildQuery>

const dictionarySql = `/* pathway:dictionary */
SELECT ${projection('d', [
  { name: 'id', kind: 'id' }, { name: 'cur_hospital_code' }, { name: 'dept_code' }, { name: 'item_type' },
  { name: 'item_code' }, { name: 'item_name', kind: 'text' }, { name: 'clinical_pathway_item_name', kind: 'text' },
], '$4')} AS data FROM cp_clinical_pathway_item_dic d
WHERE d.cur_hospital_code=$1
  AND EXISTS (SELECT 1 FROM jsonb_array_elements_text($5::jsonb) AS allowed(code)
    WHERE allowed.code=ANY(string_to_array(d.dept_code, '|')))
  AND EXISTS (SELECT 1 FROM cp_clinical_pathway_item i
    WHERE i.cur_hospital_code=$1 AND i.id::text IN (SELECT jsonb_array_elements_text($2::jsonb))
      AND i.item_type=d.item_type AND i.item_code=d.item_code)
ORDER BY d.id LIMIT $3::integer`

const drugParametersSql = `/* pathway:drugParameters */
SELECT ${projection('d', [
  { name: 'cur_hospital_code' }, { name: 'drug_code' },
  { name: 'base_dose', kind: 'decimal' }, { name: 'base_dose1', kind: 'decimal' },
  { name: 'base_unit_name1', kind: 'text' }, { name: 'skin_test_flag' },
], '$4')} AS data FROM v_cpoe_drug d
WHERE d.cur_hospital_code=$1
  AND d.drug_code IN (SELECT jsonb_array_elements_text($2::jsonb))
ORDER BY d.drug_code,d.base_dose,d.base_dose1,d.base_unit_name1,d.skin_test_flag
LIMIT $3::integer`

const sourceId = z.string().regex(/^[0-9]+$/)
function idOf(row: ClinicalSourceRow, field = 'id'): string { return sourceId.parse(row[field]) }
function idsOf(records: ClinicalSourceRow[]): string[] { return records.map(record => idOf(record)) }

function orderNodes(records: ClinicalSourceRow[], coverage: Set<string>): ClinicalSourceRow[] {
  const groups = new Map<string, ClinicalSourceRow[]>()
  for (const row of records) {
    const pathway = idOf(row, 'clinical_pathway_id')
    const group = groups.get(pathway) ?? []
    group.push(row)
    groups.set(pathway, group)
  }
  const ordered: ClinicalSourceRow[] = []
  for (const group of groups.values()) {
    const ids = new Set(idsOf(group))
    const children = new Map<string, ClinicalSourceRow[]>()
    const roots: ClinicalSourceRow[] = []
    for (const row of group) {
      const previous = row.last_node_id === null ? null : idOf(row, 'last_node_id')
      if (previous === null || previous === '0' || !ids.has(previous)) {
        roots.push(row)
        if (previous !== null && previous !== '0') coverage.add('nodes: a predecessor was not returned; ordering is partial.')
      } else {
        const siblings = children.get(previous) ?? []
        siblings.push(row)
        children.set(previous, siblings)
        if (siblings.length > 1) coverage.add('nodes: multiple successors share a predecessor; source order is ambiguous.')
      }
    }
    const seen = new Set<string>()
    const pending = [...roots].reverse()
    let sequence = 0
    for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
      const id = idOf(row)
      if (seen.has(id)) continue
      seen.add(id)
      ordered.push({ ...row, sequence: sequence++ })
      pending.push(...(children.get(id) ?? []).toReversed())
    }
    const unresolved = group.filter(row => !seen.has(idOf(row)))
    if (unresolved.length > 0) coverage.add('nodes: cyclic predecessors cannot be ordered; unresolved nodes retain their source references.')
    ordered.push(...unresolved.map(row => ({ ...row, sequence: null })))
  }
  return ordered
}

function reaches(edges: Map<string, Set<string>>, start: string, target: string): boolean {
  const pending = [start]
  const seen = new Set<string>()
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current === target) return true
    if (seen.has(current)) continue
    seen.add(current)
    pending.push(...(edges.get(current) ?? []))
  }
  return false
}

/**
 * Search scoped candidates, or expand one exact version and its bounded branch definitions.
 * @param ctx - Authorized read transaction, hospital/department grants and result limits.
 * @param args - Validated value-only selectors; only pathwayId triggers child expansion.
 * @returns Source collections with explicit missing, disabled and truncated coverage; required query failures propagate.
 */
export async function readPathway(ctx: QueryContext, args: PathwayRequest): Promise<QueryResult> {
  const result = emptyResult()
  const coverage = new Set<string>(['Definitions include false or NULL deletion markers; source review/publication states are retained.'])
  let count = 0
  async function collect(name: string, sql: string, values: (string | number)[], limit: number): Promise<ClinicalSourceRow[]> {
    const destination = result.collections[name] ??= []
    if (limit === 0) {
      result.truncated = true
      coverage.add(`${name}: not expanded because the total row limit was reached.`)
      return []
    }
    const found = await rows(ctx, sql, values)
    const kept = found.slice(0, limit)
    if (found.length > limit) {
      result.truncated = true
      coverage.add(`${name}: row limit reached; the collection is partial.`)
    }
    if (kept.some(row => row.text_truncated === true)) {
      result.truncated = true
      coverage.add(`${name}: source text exceeds the configured character limit.`)
    }
    destination.push(...kept)
    count += kept.length
    return kept
  }
  async function definitions(ids: string[], limit: number, offset = 0, search = '', code = '', version = ''): Promise<ClinicalSourceRow[]> {
    return collect('pathways', definitionSql, [ctx.scope.hospitalCode, JSON.stringify(ctx.scope.departmentCodes),
      ctx.scope.includeSharedDefinitions === true ? 1 : 0, JSON.stringify(ids), search, code, version,
      limit + 1, offset, ctx.limits.maxTextChars], limit)
  }
  async function children(name: keyof typeof childQueries, ids: string[]): Promise<ClinicalSourceRow[]> {
    result.collections[name] ??= []
    if (ids.length === 0) return []
    const limit = ctx.limits.maxRows - count
    return collect(name, childQueries[name].sql, [ctx.scope.hospitalCode, JSON.stringify(ids), limit + 1, ctx.limits.maxTextChars], limit)
  }
  const rootLimit = Math.min(args.pathwayId === undefined ? args.limit : 1, ctx.limits.maxRows)
  let current = await definitions(args.pathwayId === undefined ? [] : [args.pathwayId], rootLimit,
    args.pathwayId === undefined ? args.offset : 0, args.search ?? '', args.pathwayCode ?? '', args.versionNo ?? '')
  if (args.pathwayId === undefined) {
    if (coverage.has('pathways: row limit reached; the collection is partial.')) result.nextOffset = args.offset + current.length
    coverage.add('Search returns definition candidates only; read a pathwayId to expand its contents.')
  } else if (current.length === 0) {
    coverage.add('The requested definition is unavailable within the granted scope and selectors.')
  } else {
    result.measures.rootPathwayId = args.pathwayId
    if (ctx.limits.operationTables !== true) coverage.add('operations: optional source is not enabled.')
    if (ctx.limits.dictionaryTables !== true) {
      coverage.add('dictionary: optional source is not enabled.')
      coverage.add('drugParameters: optional source is not enabled.')
    }
    else {
      result.collections.dictionary = []
      result.collections.drugParameters = []
      coverage.add('Dictionary entries match returned item type/code and explicitly granted department segments; they are explanatory matches, not foreign keys.')
      coverage.add('Drug parameters are current dictionary values matched by returned order codes within the granted hospital; missing or duplicate matches do not establish clinical parameter values.')
    }
    if (!ctx.limits.herbalTables) coverage.add('herbalRecipes/herbalDetails: optional sources are not enabled.')
    const visited = new Set(idsOf(current))
    const edges = new Map<string, Set<string>>()
    const nodeRows: ClinicalSourceRow[] = []
    result.collections.nodes = nodeRows
    let depth = 0
    let branchCount = 0
    while (current.length > 0) {
      const pathwayIds = idsOf(current)
      await children('departments', pathwayIds)
      await children('diagnoses', pathwayIds)
      await children('assessments', pathwayIds)
      const nodes = await children('nodes', pathwayIds)
      const nodeIds = idsOf(nodes)
      const items = await children('items', nodeIds)
      const branches = await children('branches', nodeIds)
      const itemIds = idsOf(items)
      if (ctx.limits.operationTables === true) await children('operations', itemIds)
      if (ctx.limits.dictionaryTables === true) {
        if (itemIds.length > 0) {
          const limit = ctx.limits.maxRows - count
          await collect('dictionary', dictionarySql, [ctx.scope.hospitalCode, JSON.stringify(itemIds), limit + 1,
            ctx.limits.maxTextChars, JSON.stringify(ctx.scope.departmentCodes)], limit)
        }
      }
      if (ctx.limits.herbalTables) {
        const herbalIds = items.filter(item => item.item_class_code === '24').map(item => idOf(item))
        const recipes = await children('herbalRecipes', herbalIds)
        const details = await children('herbalDetails', recipes.map(recipe => idOf(recipe, 'item_id')))
        if (recipes.length < herbalIds.length) coverage.add('herbalRecipes: at least one returned herbal item has no returned recipe; coverage is incomplete.')
        const detailed = new Set(details.map(detail => idOf(detail, 'item_id')))
        if (recipes.some(recipe => !detailed.has(idOf(recipe, 'item_id')))) coverage.add('herbalDetails: at least one returned recipe has no returned ingredients; coverage is incomplete.')
      }
      const parents = new Map(nodes.map(node => [idOf(node), idOf(node, 'clinical_pathway_id')]))
      const next = new Set<string>()
      for (const branch of branches) {
        const parent = parents.get(idOf(branch, 'node_id'))
        if (parent === undefined) throw new Error('Source branch does not belong to a returned node.')
        const target = idOf(branch, 'cpid')
        if (reaches(edges, target, parent)) coverage.add('branches: cyclic definition references were detected and not expanded again.')
        const targets = edges.get(parent) ?? new Set<string>()
        targets.add(target)
        edges.set(parent, targets)
        if (visited.has(target) || next.has(target)) continue
        if (depth >= ctx.limits.maxBranchDepth || branchCount + next.size >= ctx.limits.maxBranches) {
          result.truncated = true
          coverage.add('branches: depth or definition-count limit reached; references remain visible without expansion.')
          continue
        }
        next.add(target)
      }
      if (next.size === 0) break
      for (const target of next) visited.add(target)
      branchCount += next.size
      current = await definitions([...next], Math.min(next.size, ctx.limits.maxRows - count))
      if (current.length < next.size) coverage.add('branches: some referenced definitions are unavailable within scope or the remaining row limit.')
      depth++
    }
    result.measures.branchDefinitionsRequested = branchCount
    result.collections.nodes = orderNodes(nodeRows, coverage)
    if (ctx.limits.dictionaryTables === true) {
      const codes = [...new Set((result.collections.items ?? [])
        .flatMap(item => item.item_type === 0 && typeof item.item_code === 'string' && item.item_code !== '' ? [item.item_code] : []))]
      if (codes.length > 0) {
        const limit = ctx.limits.maxRows - count
        await collect('drugParameters', drugParametersSql,
          [ctx.scope.hospitalCode, JSON.stringify(codes), limit + 1, ctx.limits.maxTextChars], limit)
      }
    }
  }
  result.measures.returnedRows = count
  result.coverage = [...coverage]
  return result
}
