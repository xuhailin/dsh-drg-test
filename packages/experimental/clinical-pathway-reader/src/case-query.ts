/** Scoped encounter evidence with independent row and document-passage pagination. */
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { z } from 'zod'
import type { CaseRequest, QueryResult } from './protocol.ts'
import { admissionScope, emptyResult, rows, scopeValues, type QueryContext } from './query.ts'

const encounterColumns = `jsonb_build_object(
  'inpatId',p.inpat_id::text,'inpatCode',p.inpat_code,'hospitalCode',p.cur_hospital_code,'isValid',p.is_valid,
  'sourceInpatId',p.source_inpat_id,'sourceInpatNo',p.source_inpat_no,
  'stateCode',p.inpat_state_code,'stateName',p.inpat_state_name,'inTime',p.in_time,'outTime',p.out_time,
  'currentDeptCode',p.current_dept_code,'outDeptCode',p.out_dept_code,'outDeptName',p.out_dept_name,
  'sexCode',p.sex_code,'sexName',p.sex_name,'age',p.age,'ageUnit',p.age_unit,'birthDate',p.birth_date,
  'dischargeModeCode',p.discharge_mode_code,'dischargeSituationCode',p.discharge_situation_code,
  'occurredAt',p.in_time::text,'availableAt',p.oper_time::text,'modifiedAt',p.oper_time,'etlTime',p.etl_time)`

const diagnosisColumns = `jsonb_build_object(
  'id',d.id::text,'inpatId',d.inpat_id::text,'hospitalCode',d.cur_hospital_code,
  'state',CASE WHEN d.is_deleted=true THEN 'deleted' WHEN d.is_suspected=true THEN 'suspected' ELSE 'recorded' END,
  'diagnosisType',d.diag_type,'diagnosisTypeName',d.diag_type_name,'name',d.diag_name,'diagnosisCode',d.diag_code,
  'icdCode',d.icd_code,'icdName',d.icd_name,'isMain',d.is_main_diag,'isSuspected',d.is_suspected,
  'isDeleted',d.is_deleted,'isCurrent',d.is_current,'diagnosedAt',d.diag_date,'modifiedAt',d.oper_time,
  'occurredAt',d.diag_date::text,'availableAt',d.oper_time::text)`

const orderColumns = `jsonb_build_object(
  'id',o.order_id::text,'inpatId',o.inpat_id::text,'hospitalCode',o.cur_hospital_code,
  'cpExecId',o.cp_exec_id::text,'cpNodeId',o.cp_node_id::text,'cpSourceProjectId',o.cp_source_project_id::text,
  'name',o.order_name,'orderTypeCode',o.order_type_code,'orderClassCode',o.order_class_code,
  'stateId',o.order_state_id,'isDeleted',o.is_deleted,'beginTime',o.begin_time,'endTime',o.end_time,
  'inputTime',o.input_time,'execTime',o.exec_time,'execNum',o.exec_num,'rowversion',o.rowversion::text,
  'stateChangeReason',o.state_change_reason,'isOutPat',o.is_out_pat,'drugCode',o.drug_code,'drugName',o.drug_name,
  'onceDose',o.once_dose,'doseUnit',o.dose_unit_name,'frequencyCode',o.frequency_code,
  'frequencyName',o.frequency_name,'usageCode',o.usage_code,'usageName',o.usage_name,
  'occurredAt',o.begin_time::text,'availableAt',NULL)`

const documentColumns = `jsonb_build_object(
  'id',r.id::text || ':' || COALESCE(c.id::text,'missing'),'recordId',r.id::text,'contentId',c.id::text,
  'inpatId',r.inpat_id::text,'hospitalCode',p.cur_hospital_code,'name',r.record_name,
  'folderCode',r.folder_code,'templateCode',r.template_code,'recordDate',r.record_date,
  'state',CASE WHEN c.record_text IS NULL OR c.record_text='' THEN 'unreadable'
    WHEN r.is_draft=true THEN 'draft' ELSE COALESCE(r.record_state_code,'recorded') END,
  'stateCode',r.record_state_code,'stateName',r.record_state_name,'isDraft',r.is_draft,
  'sign1Time',r.sign1_time,'sign2Time',r.sign2_time,'sign3Time',r.sign3_time,
  'recordModifiedAt',r.oper_time,'contentModifiedAt',c.oper_time,
  'occurredAt',r.record_date::text,'availableAt',GREATEST(r.oper_time,c.oper_time)::text,
  'fileVersion',c.file_version,'sourceTextDigest',c.record_text_md5,
  'readable',c.record_text IS NOT NULL AND c.record_text<>'','totalChars',char_length(c.record_text),
  'start',$10::integer,'length',$11::integer,
  'text',CASE WHEN ($8<>'' OR $9<>'') AND c.record_text<>''
    THEN substring(c.record_text FROM $10::integer+1 FOR $11::integer) ELSE NULL END,
  'nextStart',CASE WHEN ($8<>'' OR $9<>'') AND char_length(c.record_text)>$10::integer+$11::integer
    THEN $10::integer+$11::integer ELSE NULL END)`

const passageSchema = z.object({
  readable: z.boolean(), totalChars: z.number().int().nonnegative().nullable(),
  text: z.string().nullable(), nextStart: z.number().int().nonnegative().nullable(),
})

/**
 * Read a selected evidence category only after resolving its encounter inside the granted scope.
 * @param ctx - Authorized read transaction, scope, cancellation and deployment limits.
 * @param args - Validated category, encounter identity and bounded row or passage selectors.
 * @returns Original evidence with row continuation, per-document passage continuation and explicit gaps.
 */
export async function readCase(ctx: QueryContext, args: CaseRequest): Promise<QueryResult> {
  const values = [...scopeValues(ctx), args.inpatId]
  const scope = admissionScope(ctx, 'p')
  const encounter = await rows(ctx, `SELECT ${encounterColumns} AS data FROM cpoe_inpat_record p
    WHERE ${scope} AND p.inpat_id=$5::bigint LIMIT 2`, values)
  if (encounter.length === 0) throw new EncounterReadError('not-found', 'The encounter is unavailable within the authorized analysis scope.')
  if (encounter.length !== 1) throw new EncounterReadError('source-mismatch', 'The source does not identify a unique encounter. Check its admission mapping.')

  const result = emptyResult()
  result.coverage.push('labs:unsupported', 'checks:unsupported', 'operations:unsupported', 'administration:unsupported')
  if (args.category === 'encounter') {
    result.collections.encounter = args.offset === 0 ? encounter : []
    result.coverage.push(args.offset === 0 ? 'encounter:complete' : 'encounter:empty-page')
    return result
  }

  const limit = Math.min(args.limit, ctx.limits.maxRows)
  const pageValues = [...values, limit + 1, args.offset]
  const queries = {
    diagnoses: `SELECT ${diagnosisColumns} AS data FROM cpoe_diagnose_record d
      JOIN cpoe_inpat_record p ON p.inpat_id=d.inpat_id AND p.cur_hospital_code=d.cur_hospital_code
      WHERE ${scope} AND d.inpat_id=$5::bigint AND d.cur_hospital_code=$1
      ORDER BY d.id LIMIT $6 OFFSET $7`,
    orders: `SELECT ${orderColumns} AS data FROM cpoe_inpat_order o
      JOIN cpoe_inpat_record p ON p.inpat_id=o.inpat_id AND p.cur_hospital_code=o.cur_hospital_code
      WHERE ${scope} AND o.inpat_id=$5::bigint AND o.cur_hospital_code=$1
      ORDER BY o.order_id LIMIT $6 OFFSET $7`,
    documents: `SELECT ${documentColumns} AS data FROM cpoe_inpat_medical_record r
      JOIN cpoe_inpat_record p ON p.inpat_id=r.inpat_id
      LEFT JOIN cpoe_inpat_medical_record_content c ON c.record_id=r.id
      WHERE ${scope} AND r.inpat_id=$5::bigint
      AND ($8='' OR r.id=NULLIF($8,'')::bigint) AND ($9='' OR c.id=NULLIF($9,'')::bigint)
      ORDER BY r.id,c.id NULLS FIRST LIMIT $6 OFFSET $7`,
  }
  if (args.category === 'documents') pageValues.push(args.recordId ?? '', args.contentId ?? '', args.start, Math.min(args.length, ctx.limits.maxTextChars))
  const records = await rows(ctx, queries[args.category], pageValues)
  result.truncated = records.length > limit
  result.nextOffset = result.truncated ? args.offset + limit : null
  const page = records.slice(0, limit)
  result.collections[args.category] = page
  result.coverage.push(`${args.category}:${result.truncated ? 'partial-page' : page.length === 0 ? 'empty-page' : 'page'}`)
  if (args.category === 'orders') result.coverage.push('orders:execution-details-unsupported', 'orders:availability-time-unknown')
  if (args.category === 'documents') {
    const passages = page.map(record => passageSchema.parse(record))
    if (passages.some(passage => !passage.readable)) result.coverage.push('documents:unreadable-text')
    if (args.recordId === undefined && args.contentId === undefined) result.coverage.push('documents:text-not-requested')
    if (passages.some(passage => passage.nextStart !== null)) {
      result.truncated = true
      result.coverage.push('documents:partial-text')
    }
    result.coverage.push('documents:object-files-and-forms-unsupported')
  }
  return result
}
