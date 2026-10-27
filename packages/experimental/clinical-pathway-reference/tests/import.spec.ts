import { describe, expect, it } from 'vitest'
import type { ClinicalSourceRow, ReadResult } from '@deepseek-ai/dsh-experimental-clinical-pathway-reader/src/protocol.ts'
import { importSource } from '../src/import.ts'

function source(): ReadResult {
  return { schemaVersion: 1, tool: 'pathway_read', sourceSystem: 'emr',
    scope: { hospitalCode: '1001', departmentCodes: ['99999'], departmentBasis: 'current', admissionFrom: '2025-10-27T00:00:00Z', admissionTo: '2026-10-27T00:00:00Z', includeSharedDefinitions: false },
    readStartedAt: '2026-10-27T10:00:00Z', readCompletedAt: '2026-10-27T10:00:01Z', filters: { pathwayId: '100' },
    collections: { pathways: [{ id: '100', pathway_code: 'CP-1', pathway_name: 'Synthetic pathway', version_no: '2.0', dept_code: '99999', dept_name: 'Synthetic department', fee_lower_limit: '0.00', fee_upper_limit: '200.50', days_lower_limit: 1, days_upper_limit: 4 }],
      departments: [{ id: '101', clinical_pathway_id: '100', dept_code: '99999', dept_name: 'Synthetic department' }],
      diagnoses: [{ id: '102', clinical_pathway_id: '100', diagnosis_code: 'X00', diagnosis_name: 'Synthetic diagnosis', copy_id: null }],
      assessments: [{ id: '103', clinical_pathway_id: '100', evaluation_type: 0, evaluation_criteria: 'Include synthetic criterion', is_required: true },
        { id: '104', clinical_pathway_id: '100', evaluation_type: 1, evaluation_criteria: 'Exclude synthetic criterion', is_required: false }],
      nodes: [{ id: '201', clinical_pathway_id: '100', last_node_id: null, sequence: 0, node_attribute: 0, node_name: 'Admission', days_lower_limit: 1, days_upper_limit: 1 },
        { id: '202', clinical_pathway_id: '100', last_node_id: '201', sequence: 1, node_attribute: 1, node_name: 'Surgery', days_lower_limit: 0, days_upper_limit: 0 }],
      items: [], branches: [], operations: [], herbalRecipes: [], herbalDetails: [] },
    measures: { rootPathwayId: '100', returnedRows: 8 }, nextOffset: null, truncated: false, coverage: [],
  }
}

function item(id: string, overrides: ClinicalSourceRow = {}): ClinicalSourceRow {
  return { id, node_id: '201', item_type: 0, item_code: 'ITEM-' + id, item_name: 'Synthetic item ' + id, once_dose: 0,
    group_flag: 0, group_package_flag: 0, group_package_sn: 1, group_sign: Number(id), group_sort: Number(id),
    is_required: false, is_repeatable: true, is_multiple_choice: false, is_once_dose_change: true, ...overrides }
}

describe('logged pathway import', () => {
  it('preserves same-hospital current drug parameters and the EMR sending-unit projection', () => {
    const raw = source()
    raw.collections.items = [item('301', { item_class_code: '1', item_code: 'SYN-DRUG', pack_unit_name: 'Synthetic package' })]
    raw.collections.drugParameters = [{ cur_hospital_code: '1001', drug_code: 'SYN-DRUG', base_dose: '0.000', base_dose1: '250.5',
      base_unit_name1: 'mg', skin_test_flag: false }]
    const imported = importSource(raw)
    expect(imported.definition.clinicalPathway.treatments?.[0]?.orderTreatmentProjects?.[0]).toMatchObject({
      baseDose: 0, baseDose1: 250.5, baseUnitName1: 'mg', skinTestFlag: false, sendUnit: 'Synthetic package',
    })
    expect(imported.metadata.questions.filter(q => q.field === 'drugParameters')).toEqual([])
  })

  it.each(['missing', 'duplicate', 'partial', 'other-hospital'])('keeps %s drug parameters unknown and locatable', (kind) => {
    const raw = source()
    raw.collections.items = [item('301', { item_class_code: '1', item_code: 'SYN-DRUG' })]
    const match = { cur_hospital_code: '1001', drug_code: 'SYN-DRUG', base_dose: '250', base_dose1: '250',
      base_unit_name1: 'mg', skin_test_flag: false }
    if (kind === 'duplicate') raw.collections.drugParameters = [match, match]
    if (kind === 'other-hospital') raw.collections.drugParameters = [{ ...match, cur_hospital_code: 'other' }]
    if (kind === 'partial') { raw.collections.drugParameters = [match]; raw.coverage.push('drugParameters: row limit reached; partial.') }
    const imported = importSource(raw)
    expect(imported.definition.clinicalPathway.treatments?.[0]?.orderTreatmentProjects?.[0]).toMatchObject({
      baseDose: null, baseDose1: null, baseUnitName1: null, skinTestFlag: null,
    })
    expect(imported.metadata.questions).toEqual(expect.arrayContaining([expect.objectContaining({ localId: 'source:item:301', field: 'drugParameters' })]))
  })

  it('preserves exact version, department code/name, inclusion meaning, zero dose and predecessor', () => {
    const raw = source()
    raw.collections.items!.push(item('301', { frequency_code: 'QD', frequency_name: 'Daily', usage_code: 'PO', usage_name: 'Oral', exec_dept_code: '99999', exec_dept_name: 'Synthetic department', dose_unit: 'mg' }))
    const imported = importSource(raw)
    const pathway = imported.definition.clinicalPathway
    expect(pathway.version).toBe('2.0')
    expect(pathway.deptInfos?.[0]).toMatchObject({ deptCode: '99999', deptName: 'Synthetic department' })
    expect(pathway.inclusionAssessment?.map(row => row.isInclude)).toEqual([true, false])
    expect(pathway.feesRange).toEqual([0, 200.5])
    expect(pathway.treatments?.[1]).toMatchObject({ nodeAttribute: 1, inpatDayRange: [0, 0], parentTreatmentId: 201, parentTreatmentLocalId: 'source:node:201' })
    expect(pathway.treatments?.[0]?.orderTreatmentProjects?.[0]).toMatchObject({ drugCode: 'ITEM-301', onceDose: { value: 0, adjustable: true }, frequency: { code: 'QD', name: 'Daily' }, singleUse: true })
    expect(imported.definitionId).toBe('100')
    expect(imported.scope.sourceSystem).toBe('emr')
  })

  it('restores groups and bundle groups without fabricated business identities or duplicate headers', () => {
    const raw = source()
    raw.collections.items = [item('310', { group_flag: 2, group_sort: 2, group_sign: 2 }), item('311', { group_flag: 2, group_sort: 2, group_sign: 1 }),
      item('320', { group_package_flag: 3, group_package_sn: 0, item_name: 'Bundle', group_sign: 3 }),
      item('321', { group_package_flag: 3, group_package_sn: 1, group_sort: 0, group_sign: 2 }),
      item('322', { group_package_flag: 3, group_package_sn: 2, group_flag: 4, group_sort: 1, group_sign: 1 }),
      item('323', { group_package_flag: 3, group_package_sn: 3, group_flag: 4, group_sort: 1, group_sign: 2 })]
    const orders = importSource(raw).definition.clinicalPathway.treatments?.[0]?.orderTreatmentProjects
    expect(orders).toHaveLength(2)
    const group = orders?.[0]
    expect(group?.levelType).toBe(2)
    if (group?.levelType !== 2) throw new Error('Expected group')
    expect(group.id).toBeUndefined()
    expect(group.children?.map(row => row.id)).toEqual([311, 310])
    const bundle = orders?.[1]
    if (bundle?.levelType !== 3) throw new Error('Expected bundle')
    expect(bundle).toMatchObject({ name: 'Bundle', id: 320 })
    expect(bundle.children?.map(row => row.levelType)).toEqual([2, 1])
    expect(JSON.stringify(bundle.children)).not.toContain('"id":320')
  })

  it('retains herbal header and ingredients, work, nursing and external branches', () => {
    const raw = source()
    raw.collections.pathways!.push({ id: '900', pathway_code: 'BRANCH', pathway_name: 'Related', version_no: '3' })
    raw.collections.items = [item('330', { item_class_code: '24', item_name: 'Herbal order' }), item('331', { item_type: 1, template_code: 'RECORD' }), item('332', { item_type: 2 })]
    raw.collections.herbalRecipes = [{ item_id: '330', order_name: 'Synthetic recipe', drug_count: 3, decoct_count: 1, decoction_dosage: '20.5', decoction_times: 2, is_decoction: true, is_prescription: false, is_out_pat: 0, usage_code2: 'U2', usage_name2: 'Second usage' }]
    raw.collections.herbalDetails = [{ id: '340', item_id: '330', drug_id: '341', drug_code: 'HERB', drug_name: 'Synthetic herb', dose_unit_code: 'g', dose_unit_name: 'gram', once_dose: '0.000', qty: '3.5', sort: 0 }]
    raw.collections.operations = [{ id: '350', item_id: '330', operation_code: 'OP', operation_name: 'Synthetic operation' }]
    raw.collections.branches = [{ id: '360', node_id: '201', cpid: '900', clinical_properties: 'Branch condition' }]
    const phase = importSource(raw).definition.clinicalPathway.treatments?.[0]
    expect(phase?.recordTreatmentProjects?.[0]).toMatchObject({ projectType: 1, templateCode: 'RECORD' })
    expect(phase?.nursingTreatmentProjects?.[0]?.projectType).toBe(2)
    expect(phase?.branchs?.[0]).toMatchObject({ relatedClinicalPathwayId: 900, relatedClinicalPathwayCode: 'BRANCH', relatedClinicalPathwayLocalId: null })
    const order = phase?.orderTreatmentProjects?.[0]
    if (order?.levelType !== 1) throw new Error('Expected single')
    expect(order.operations?.[0]?.operationCode).toBe('OP')
    expect(order.herbalRecipe).toMatchObject({ orderName: 'Synthetic recipe', decoctionDosage: 20.5, usageCode2: 'U2', detail: [{ drugId: 341, onceDose: 0, qty: 3.5 }] })
  })

  it('keeps bigint source identity exact and reports lossy numbers instead of rounding', () => {
    const raw = source()
    raw.collections.items = [item('9223372036854775807', { once_dose: '123456789012345678.123' })]
    const imported = importSource(raw)
    expect(imported.definition.clinicalPathway.treatments?.[0]?.orderTreatmentProjects?.[0]).toMatchObject({ localId: 'source:item:9223372036854775807', id: null, onceDose: { value: null } })
    expect(imported.metadata.questions.map(row => row.field)).toEqual(expect.arrayContaining(['id', 'onceDose/value']))
    expect(raw.collections.items[0]?.id).toBe('9223372036854775807')
  })

  it('distinguishes unread, partial empty and known empty collections', () => {
    const raw = source()
    delete raw.collections.diagnoses
    raw.coverage.push('assessments: row limit reached; the collection is partial.')
    raw.collections.assessments = []
    raw.truncated = true
    const imported = importSource(raw)
    expect(imported.definition.clinicalPathway).toMatchObject({ diagnoseGroup: null, inclusionAssessment: null })
    expect(imported.definition.clinicalPathway.treatments?.[0]?.recordTreatmentProjects).toEqual([])
    expect(imported.metadata.questions.map(row => row.field)).toEqual(expect.arrayContaining(['diagnoses', 'assessments']))
    expect(imported.metadata.coverage).toContain('The source read was truncated; this reference is not a complete hospital definition.')
  })

  it('retains missing or cyclic predecessor identities with locatable gaps', () => {
    const raw = source()
    raw.collections.nodes![0]!.last_node_id = '999'
    raw.collections.nodes![1]!.last_node_id = '202'
    raw.collections.nodes![1]!.sequence = null
    const imported = importSource(raw)
    expect(imported.definition.clinicalPathway.treatments?.map(row => row.parentTreatmentLocalId)).toEqual([null, null])
    expect(imported.definition.clinicalPathway.treatments?.map(row => row.parentTreatmentId)).toEqual([999, 202])
    expect(imported.metadata.questions.filter(row => row.field === 'parentTreatmentLocalId')).toHaveLength(2)
  })

  it('rejects candidate lists, missing exact source, history and incompatible scope', () => {
    const raw = source()
    delete raw.filters.pathwayId
    expect(() => importSource(raw)).toThrow('one exact')
    expect(() => importSource({ ...source(), tool: 'history_query' })).toThrow('one exact')
    const missing = source()
    missing.collections.pathways = []
    expect(() => importSource(missing)).toThrow('missing or duplicated')
    const scope = source()
    scope.scope.departmentBasis = 'discharge'
    expect(() => importSource(scope)).toThrow('current-department')
  })

  it('keeps unknown grouping out of fabricated singles and marks incomplete headers', () => {
    const raw = source()
    raw.collections.items = [item('370', { group_flag: null }), item('371', { group_package_flag: 8, group_package_sn: 1 })]
    const imported = importSource(raw)
    expect(imported.definition.clinicalPathway.treatments?.[0]?.orderTreatmentProjects).toHaveLength(1)
    expect(imported.metadata.questions.map(row => row.field)).toEqual(expect.arrayContaining(['orderTreatmentProjects', 'children']))
  })
})
