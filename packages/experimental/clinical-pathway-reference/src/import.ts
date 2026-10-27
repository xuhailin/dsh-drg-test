/** Converts logged source evidence to the EMR-owned definition without source writes. */
import { resultSchema, type ClinicalSourceRow } from '@deepseek-ai/dsh-experimental-clinical-pathway-reader/src/protocol.ts'
import { readDefinition } from './emr/definition-reader.ts'
import type { DefinitionDocument } from './emr/definition.generated.d.ts'
import type { ReferenceMetadata, ReferenceScope } from './types.ts'

/** One exact source definition with its frozen analysis context and explicit gaps. */
export interface ImportedSource {
  definition: DefinitionDocument
  metadata: ReferenceMetadata
  definitionId: string
  readAt: string
  sourceSystem: string
  scope: ReferenceScope
}

type JsonObject = Record<string, unknown>

function text(value: unknown): string | null { return typeof value === 'string' ? value : null }
function bool(value: unknown): boolean | null { return typeof value === 'boolean' ? value : null }
function identity(row: ClinicalSourceRow, field = 'id'): string {
  const value = row[field]
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new Error(`Source ${field} is not an exact decimal identity.`)
  return value
}
function local(kind: string, id: string): string { return `source:${kind}:${id}` }
function camel(value: string): string { return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) }
function decimal(value: string): string {
  return value.replace(/^\+/, '').replace(/^(-?)0+(?=\d)/, '$1').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^-0$/, '0')
}

/**
 * Import one previously logged pathway_read expansion, preserving unread collections as null.
 * @param input - Reader result whose tool invocation and Session ownership were checked by the caller.
 * @returns EMR-valid clinical data, source identity, frozen scope and locatable evidence gaps.
 */
export function importSource(input: unknown): ImportedSource {
  const result = resultSchema.parse(input)
  if (result.tool !== 'pathway_read' || typeof result.filters.pathwayId !== 'string'
    || result.measures.rootPathwayId !== result.filters.pathwayId || result.scope.departmentBasis !== 'current') {
    throw new Error('Reference revision requires one exact pathway_read result in current-department scope.')
  }
  const definitionId = result.filters.pathwayId
  const rootRows = (result.collections.pathways ?? []).filter(row => row.id === definitionId)
  if (rootRows.length !== 1) throw new Error('Exact source definition is missing or duplicated.')
  const root = rootRows[0]
  if (root === undefined) throw new Error('Exact source definition is missing.')
  const rootId = local('pathway', definitionId)
  const metadata: ReferenceMetadata = { coverage: [...result.coverage], questions: [], evidence: [] }
  function question(localId: string, field: string, message: string): void {
    if (metadata.questions.length < 999) metadata.questions.push({ localId, field, message })
    else if (metadata.questions.length === 999) metadata.questions.push({ localId: rootId, field: '*', message: 'Additional mapping gaps remain in the logged source; question display reached its limit.' })
  }
  function numeric(value: unknown, localId: string, field: string, integer = false): number | null {
    if (value === null || value === undefined) return null
    const candidate = typeof value === 'number' ? value : typeof value === 'string' && /^[-+]?\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN
    if (Number.isFinite(candidate) && Math.abs(candidate) <= Number.MAX_SAFE_INTEGER
      && (!integer || Number.isSafeInteger(candidate))
      && (typeof value !== 'string' || decimal(String(candidate)) === decimal(value))) return candidate
    question(localId, field, `Source value cannot be represented exactly as an EMR number: ${JSON.stringify(value)}.`)
    return null
  }
  function sourceId(value: unknown, localId: string, field: string): number | null {
    return numeric(value, localId, field, true)
  }
  function nullableText(value: unknown): string | null {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value)
  }
  function pair(row: ClinicalSourceRow, code: string, name: string): JsonObject {
    return { code: nullableText(row[code]), name: text(row[name]) }
  }
  function scalarFields(row: ClinicalSourceRow, names: string[]): JsonObject {
    return Object.fromEntries(names.map(name => [camel(name), text(row[name])]))
  }
  function numbers(row: ClinicalSourceRow, names: string[], localId: string): JsonObject {
    return Object.fromEntries(names.map(name => [camel(name), numeric(row[name], localId, camel(name))]))
  }
  function range(
    row: ClinicalSourceRow, lower: string, upper: string, localId: string, field: string,
  ): [number | null, number | null] | null {
    const min = numeric(row[lower], localId, field + '/0')
    const max = numeric(row[upper], localId, field + '/1')
    if (min !== null && max !== null && min > max) {
      question(localId, field, `Source lower limit ${min} exceeds upper limit ${max}; both remain in logged evidence.`)
      return null
    }
    return min === null && max === null ? null : [min, max]
  }
  function records(name: string, parentField: string, parentId: string, owner: string): ClinicalSourceRow[] | null {
    const rows = result.collections[name]
    if (rows === undefined) {
      question(owner, name, 'Source collection was not read; it is unknown, not empty.')
      return null
    }
    const filtered = rows.filter(row => row[parentField] === parentId)
    const incomplete = result.coverage.some(note => note.startsWith(name + ':') && /partial|not expanded|limit|incomplete|not enabled/.test(note))
    if (incomplete) question(owner, name, 'Source collection is incomplete; only returned records are shown.')
    return filtered.length === 0 && incomplete ? null : filtered
  }
  function basics(row: ClinicalSourceRow, kind: string): JsonObject {
    const id = identity(row)
    const localId = local(kind, id)
    if (row.text_truncated === true) question(localId, '*', 'Source text is truncated; the complete text was not read.')
    return { localId, id: sourceId(id, localId, 'id') }
  }
  function operations(item: ClinicalSourceRow): JsonObject[] | null {
    const itemId = identity(item)
    const owner = local('item', itemId)
    return records('operations', 'item_id', itemId, owner)?.map(row => ({
      ...basics(row, 'operation'), operationCode: text(row.operation_code), operationCode2: text(row.operation_code2), operationName: text(row.operation_name),
    })) ?? null
  }
  function drugParameters(item: ClinicalSourceRow, localId: string): JsonObject {
    const unknown = { baseDose: null, baseDose1: null, baseUnitName1: null, skinTestFlag: null }
    const candidates = result.collections.drugParameters
    const code = text(item.item_code)
    const pharmacologic = ['1', '2', '3'].includes(nullableText(item.item_class_code) ?? '')
    const incomplete = result.coverage.some(note => note.startsWith('drugParameters:') && /partial|limit|incomplete/.test(note))
    const matches = candidates?.filter(row => row.cur_hospital_code === result.scope.hospitalCode && row.drug_code === code) ?? []
    if (candidates === undefined || incomplete || matches.length !== 1) {
      if (pharmacologic || matches.length > 1) question(localId, 'drugParameters', candidates === undefined
        ? 'Drug conversion parameters were not read; no dose conversion or skin-test value was assumed.'
        : incomplete ? 'Drug parameters were read only partially; code uniqueness cannot be established.'
          : matches.length > 1 ? 'Multiple same-hospital catalog records match this item code; no record was selected.'
            : 'No same-hospital drug catalog record matched this item code; conversion parameters remain unknown.')
      return unknown
    }
    const match = matches[0]
    if (match === undefined) return unknown
    if (match.text_truncated === true) question(localId, 'drugParameters', 'Drug parameter text is truncated in the logged source.')
    return { baseDose: numeric(match.base_dose, localId, 'baseDose'), baseDose1: numeric(match.base_dose1, localId, 'baseDose1'),
      baseUnitName1: text(match.base_unit_name1), skinTestFlag: bool(match.skin_test_flag) }
  }
  function herbal(item: ClinicalSourceRow): JsonObject | null {
    if (nullableText(item.item_class_code) !== '24') return null
    const itemId = identity(item)
    const localId = local('herbal', itemId)
    const recipes = records('herbalRecipes', 'item_id', itemId, localId)
    if (recipes === null || recipes.length !== 1) {
      question(localId, 'herbalRecipe', 'Exactly one herbal header was not returned; the prescription remains unknown.')
      return null
    }
    const recipe = recipes[0]
    if (recipe === undefined) throw new Error('Herbal header disappeared during import.')
    if (recipe.text_truncated === true) question(localId, '*', 'Herbal header text is truncated; the complete text was not read.')
    return { localId, orderName: text(recipe.order_name),
      ...scalarFields(recipe, ['order_type_code', 'exec_dept_code', 'exec_dept_name', 'usage_code', 'usage_name', 'usage_code2', 'usage_name2', 'frequency_code', 'frequency_name', 'decoction_code', 'decoction_name', 'rules_treatment_name', 'note', 'special_usage_code', 'special_usage_name', 'herb_type_code', 'rate_code', 'rate_name']),
      ...numbers(recipe, ['drug_count', 'decoct_count', 'decoction_dosage', 'decoction_times', 'is_out_pat'], localId),
      isDecoction: bool(recipe.is_decoction), isPrescription: bool(recipe.is_prescription),
      detail: records('herbalDetails', 'item_id', itemId, localId)?.map((row) => {
        const detailId = local('herbal-detail', identity(row))
        return { ...basics(row, 'herbal-detail'), drugId: sourceId(row.drug_id, detailId, 'drugId'),
          ...scalarFields(row, ['drug_code', 'drug_name', 'order_sub_class_code', 'order_sub_class_name', 'specs', 'dose_unit_code', 'dose_unit_name', 'dosage_code', 'dosage_name', 'base_unit_code', 'base_unit_name', 'send_unit_code', 'send_unit_name', 'usage_code', 'usage_name', 'usage_code2', 'usage_name2', 'min_unit_code', 'min_unit_name', 'pack_unit_code', 'pack_unit_name', 'note', 'herb_type_code']),
          ...numbers(row, ['qty', 'once_dose', 'base_dose', 'send_pack_qty', 'pack_qty', 'unit_sort', 'sort'], detailId),
        }
      }) ?? null,
    }
  }
  function single(row: ClinicalSourceRow): JsonObject {
    const id = identity(row)
    const localId = local('item', id)
    if (row.operation_apply_id !== null && row.operation_apply_id !== undefined) question(localId, 'applyData', 'Source application identity exists; application fields were not expanded by this read.')
    return { ...basics(row, 'item'), projectType: 0, levelType: 1, code: nullableText(row.item_code), drugCode: text(row.item_code), name: text(row.item_name),
      sort: numeric(row.group_sign, localId, 'sort'),
      orderClass: pair(row, 'item_class_code', 'item_class_name'), orderSubClass: pair(row, 'item_sub_class_code', 'item_sub_class_name'),
      orderTypeCode: text(row.order_type_code), unit: { code: null, name: text(row.dose_unit) },
      frequency: pair(row, 'frequency_code', 'frequency_name'), usage: pair(row, 'usage_code', 'usage_name'),
      usageType: pair(row, 'usage_type_code', 'usage_type_name'), execDept: pair(row, 'exec_dept_code', 'exec_dept_name'),
      onceDose: { value: numeric(row.once_dose, localId, 'onceDose/value'), adjustable: bool(row.is_once_dose_change) },
      drugId: sourceId(row.drug_id, localId, 'drugId'), days: numeric(row.days, localId, 'days'),
      ...scalarFields(row, ['specs', 'base_unit_name', 'min_unit_name', 'pack_unit_name', 'template_code', 'group_code', 'remark']),
      sendUnit: text(row.pack_unit_name), ...drugParameters(row, localId),
      singleUse: typeof row.is_multiple_choice === 'boolean' ? !row.is_multiple_choice : null,
      required: bool(row.is_required), repeatable: bool(row.is_repeatable), isApplyOrder: bool(row.is_apply_order),
      testIsGroup: bool(row.test_is_group), isSelf: bool(row.is_self),
      operations: operations(row), applyData: null, herbalRecipe: herbal(row),
    }
  }
  function sorted(rows: JsonObject[]): JsonObject[] {
    return rows.sort((a, b) => (typeof a.sort === 'number' ? a.sort : Infinity) - (typeof b.sort === 'number' ? b.sort : Infinity))
  }
  function groups(rows: ClinicalSourceRow[], nodeId: string, bundle: string): JsonObject[] {
    const grouped = new Map<string, ClinicalSourceRow[]>()
    for (const row of rows) {
      const flag = JSON.stringify(row.group_flag)
      const list = grouped.get(flag) ?? []
      list.push(row)
      grouped.set(flag, list)
    }
    return [...grouped].map(([flag, children]) => {
      const localId = local('group', `${nodeId}:${bundle}:${flag}`)
      return { localId, projectType: 0, levelType: 2, name: null,
        sort: numeric(children[0]?.group_sort, localId, 'sort'), children: sorted(children.map(row => single(row))),
      }
    })
  }
  function orders(rows: ClinicalSourceRow[], nodeId: string): JsonObject[] {
    const owner = local('node', nodeId)
    const known = rows.filter(row => typeof row.group_flag === 'number' && row.group_flag >= 0
      && typeof row.group_package_flag === 'number' && row.group_package_flag >= 0)
    if (known.length !== rows.length) question(owner, 'orderTreatmentProjects', 'Some order grouping flags are unknown; those rows remain only in source evidence and were not flattened.')
    const singles = known.filter(row => row.group_flag === 0 && row.group_package_flag === 0).map(row => single(row))
    const standalone = groups(known.filter(row => Number(row.group_flag) > 0 && row.group_package_flag === 0), nodeId, '0')
    const bundled = new Map<string, ClinicalSourceRow[]>()
    for (const row of known.filter(row => Number(row.group_package_flag) > 0)) {
      const flag = JSON.stringify(row.group_package_flag)
      const list = bundled.get(flag) ?? []
      list.push(row)
      bundled.set(flag, list)
    }
    const bundles = [...bundled].map(([flag, children]) => {
      const parents = children.filter(row => row.group_package_sn === 0)
      const localId = local('bundle', `${nodeId}:${flag}`)
      if (parents.length !== 1) question(localId, 'children', 'Bundle header is missing or duplicated; the available members remain visible.')
      const parent = parents.length === 1 ? parents[0] : undefined
      if (parent !== undefined) {
        const headerOnly = new Set(['id', 'node_id', 'item_type', 'item_name', 'group_flag', 'group_package_flag', 'group_package_sn', 'group_sort', 'group_sign', 'group_sn', 'is_required', 'is_repeatable', 'is_multiple_choice', 'text_truncated'])
        const retainedOnly = Object.keys(parent).filter(field =>
          !headerOnly.has(field) && parent[field] !== null && parent[field] !== undefined)
        if (retainedOnly.length > 0) question(localId, '*', `Bundle header fields have no EMR shared container field and remain in logged source: ${retainedOnly.join(', ')}.`)
        if (parent.text_truncated === true) question(localId, '*', 'Bundle header text is truncated; the complete text was not read.')
      }
      const members = children.filter(row => row.group_package_sn !== 0)
      return { localId, id: parent === undefined ? null : sourceId(parent.id, localId, 'id'), projectType: 0, levelType: 3,
        name: text(parent?.item_name), sort: numeric(parent?.group_sign, localId, 'sort'),
        required: bool(parent?.is_required), repeatable: bool(parent?.is_repeatable),
        singleUse: typeof parent?.is_multiple_choice === 'boolean' ? !parent.is_multiple_choice : null,
        children: sorted([...members.filter(row => row.group_flag === 0).map(row => single(row)),
          ...groups(members.filter(row => Number(row.group_flag) > 0), nodeId, flag)]),
      }
    })
    return sorted([...singles, ...standalone, ...bundles])
  }
  const sourceNodes = records('nodes', 'clinical_pathway_id', definitionId, rootId)
  const nodeIds = new Set(sourceNodes?.map(row => identity(row)))
  const treatments = sourceNodes?.map((row) => {
    const nodeId = identity(row)
    const localId = local('node', nodeId)
    const previous = text(row.last_node_id)
    let predecessor = previous !== null && previous !== '0' && nodeIds.has(previous) ? local('node', previous) : null
    if (previous !== null && previous !== '0' && predecessor === null) question(localId, 'parentTreatmentLocalId', `Predecessor ${previous} was not returned; source identity is retained separately.`)
    if (row.sequence === null && predecessor !== null) {
      question(localId, 'parentTreatmentLocalId', 'Cyclic source predecessor cannot be represented as a valid local chain; source identity is retained separately.')
      predecessor = null
    }
    const items = records('items', 'node_id', nodeId, localId)
    if (items?.some(item => item.item_type !== 0 && item.item_type !== 1 && item.item_type !== 2)) question(localId, 'projects', 'An unknown item category remains in logged evidence; no category was guessed.')
    function work(projectType: 1 | 2): JsonObject[] | null {
      return items?.filter(item => item.item_type === projectType).map(item => ({ ...basics(item, 'item'), projectType,
        code: nullableText(item.item_code), name: text(item.item_name), templateCode: text(item.template_code),
        required: bool(item.is_required), repeatable: bool(item.is_repeatable), sort: numeric(item.group_sign, local('item', identity(item)), 'sort'),
      })) ?? null
    }
    const branches = records('branches', 'node_id', nodeId, localId)?.map((branch) => {
      const branchId = local('branch', identity(branch))
      const targetId = identity(branch, 'cpid')
      const target = result.collections.pathways?.find(pathway => pathway.id === targetId)
      return { ...basics(branch, 'branch'), name: text(target?.pathway_name), parentTreatmentId: sourceId(nodeId, branchId, 'parentTreatmentId'),
        relatedClinicalPathwayId: sourceId(targetId, branchId, 'relatedClinicalPathwayId'), relatedClinicalPathwayLocalId: null,
        relatedClinicalPathwayCode: text(target?.pathway_code), relatedClinicalPathwayVersion: text(target?.version_no),
        clinicalProperties: text(branch.clinical_properties),
      }
    }) ?? null
    if (row.is_exist_branch_path === true && (branches === null || branches.length === 0)) question(localId, 'branchs', 'The node declares a branch but no branch record was returned.')
    if (row.branch_path_id !== null && row.branch_path_id !== undefined && (branches === null || branches.length === 0)) question(localId, 'branchs', `Node branch identity ${JSON.stringify(row.branch_path_id)} remains in source evidence; no corresponding branch record was returned.`)
    const anchor = row.node_attribute === 0 || row.node_attribute === 1 || row.node_attribute === 2 ? row.node_attribute : null
    return { ...basics(row, 'node'), name: text(row.node_name), sort: numeric(row.sequence, localId, 'sort'),
      clinicalAttributes: text(row.clinical_properties), nodeAttribute: anchor,
      inpatDayRange: range(row, 'days_lower_limit', 'days_upper_limit', localId, 'inpatDayRange'),
      parentTreatmentId: previous === null || previous === '0' ? null : sourceId(previous, localId, 'parentTreatmentId'), parentTreatmentLocalId: predecessor,
      branchs: branches, recordTreatmentProjects: work(1), nursingTreatmentProjects: work(2),
      orderTreatmentProjects: items === null ? null : orders(items.filter(item => item.item_type === 0), nodeId),
    }
  }) ?? null
  const definition = readDefinition({ format: 'emr-clinical-pathway-definition', schemaVersion: 1,
    clinicalPathway: { ...basics(root, 'pathway'), code: text(root.pathway_code), name: text(root.pathway_name), version: text(root.version_no),
      isTreatmentPackage: bool(root.is_treatment_package), isBranchPath: bool(root.is_branch_path), createDept: pair(root, 'dept_code', 'dept_name'),
      deptInfos: records('departments', 'clinical_pathway_id', definitionId, rootId)?.map(row => ({ ...basics(row, 'department'), deptCode: text(row.dept_code), deptName: text(row.dept_name) })) ?? null,
      feesRange: range(root, 'fee_lower_limit', 'fee_upper_limit', rootId, 'feesRange'),
      inpatDayRange: range(root, 'days_lower_limit', 'days_upper_limit', rootId, 'inpatDayRange'),
      diagnoseGroup: records('diagnoses', 'clinical_pathway_id', definitionId, rootId)?.map(row => ({ ...basics(row, 'diagnosis'),
        code: text(row.diagnosis_code), name: text(row.diagnosis_name), copyId: sourceId(row.copy_id, local('diagnosis', identity(row)), 'copyId'),
      })) ?? null,
      inclusionAssessment: records('assessments', 'clinical_pathway_id', definitionId, rootId)?.map(row => ({ ...basics(row, 'assessment'),
        inclusionItem: text(row.evaluation_criteria),
        isInclude: row.evaluation_type === 0 ? true : row.evaluation_type === 1 ? false : null,
        required: bool(row.is_required), basisKind: text(row.basis_kind), basisKindName: text(row.basis_kind_name),
      })) ?? null, treatments,
    },
  })
  if (result.truncated) metadata.coverage.push('The source read was truncated; this reference is not a complete hospital definition.')
  return { definition, metadata, definitionId, readAt: result.readCompletedAt, sourceSystem: result.sourceSystem,
    scope: { sourceSystem: result.sourceSystem, hospitalCode: result.scope.hospitalCode, departmentCodes: result.scope.departmentCodes,
      departmentBasis: 'current', admissionFrom: result.scope.admissionFrom, admissionTo: result.scope.admissionTo },
  }
}
