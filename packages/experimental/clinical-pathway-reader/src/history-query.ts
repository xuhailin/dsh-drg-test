/** Historical admission cohorts retain source execution states without inferring clinical completion. */
import { z } from 'zod'
import type { HistoryRequest, QueryResult, ClinicalSourceRow } from './protocol.ts'
import { admissionScope, emptyResult, rows, scopeValues, type QueryContext } from './query.ts'

const countKeys = [
  'admissionCount', 'executionCount', 'admissionsWithoutExecutionCount', 'notIncludedCount', 'underwayCount',
  'exitCount', 'systemMarkedCompleteCount', 'offPathwayTreatmentCount', 'unknownExecutionStatusCount',
  'unknownExecutionDeletedFlagCount', 'unknownTreatmentPackageFlagCount', 'currentReasonCount',
  'reasonVariationTrueCount', 'reasonVariationFalseCount', 'reasonVariationUnknownCount', 'executionsWithoutRetainedReasonCount',
] as const

function cohortSql(ctx: QueryContext): string {
  return `scoped_admissions AS (
    SELECT p.inpat_id,p.inpat_code,p.cur_hospital_code,p.inpat_state_code,p.in_time,p.out_time,
      p.current_dept_code,p.out_dept_code,p.out_dept_name,p.oper_time
    FROM cpoe_inpat_record p WHERE ${admissionScope(ctx, 'p')}
      AND (($7='admission' AND p.in_time >= $5::timestamptz AND p.in_time < $6::timestamptz)
        OR ($7='discharge' AND p.out_time >= $5::timestamptz AND p.out_time < $6::timestamptz) OR $7='execution')
      AND (($10='' AND $12='' AND NOT $13::boolean) OR EXISTS (
        SELECT 1 FROM cpoe_diagnose_record d WHERE d.inpat_id=p.inpat_id AND d.cur_hospital_code=p.cur_hospital_code
          AND d.is_deleted IS NOT TRUE AND ($10='' OR ($11='icd' AND d.icd_code=$10) OR ($11='hospital' AND d.diag_code=$10))
          AND ($12='' OR d.diag_type=$12) AND (NOT $13::boolean OR d.is_main_diag=true)))
  ), filtered_executions AS (
    SELECT e.id,e.cur_hospital_code,e.inpat_id,e.inpat_code,e.pathway_id,e.pathway_code,e.version_no,e.pathway_name,
      e.execution_status,e.create_time,e.oper_time,e.dept_code,e.is_deleted,e.is_treatment_package,e.evaluation_id
    FROM cp_clinical_pathway_execution_records e WHERE e.cur_hospital_code=$1
      AND e.is_deleted IS NOT TRUE AND e.is_treatment_package IS NOT TRUE
      AND EXISTS (SELECT 1 FROM scoped_admissions p WHERE p.inpat_id=e.inpat_id)
      AND ($8='' OR e.pathway_id=NULLIF($8,'')::bigint) AND ($9='' OR e.execution_status::text=$9)
      AND ($7<>'execution' OR (e.create_time >= $5::timestamptz AND e.create_time < $6::timestamptz))
  ), cohort AS (
    SELECT p.inpat_id,p.inpat_code,p.cur_hospital_code,p.inpat_state_code,p.in_time,p.out_time,
      p.current_dept_code,p.out_dept_code,p.out_dept_name,p.oper_time FROM scoped_admissions p
    WHERE ($7<>'execution' AND $8='' AND $9='') OR EXISTS (SELECT 1 FROM filtered_executions e WHERE e.inpat_id=p.inpat_id)
  ), selected_executions AS (
    SELECT e.id,e.cur_hospital_code,e.inpat_id,e.inpat_code,e.pathway_id,e.pathway_code,e.version_no,e.pathway_name,
      e.execution_status,e.create_time,e.oper_time,e.dept_code,e.is_deleted,e.is_treatment_package,e.evaluation_id
    FROM filtered_executions e WHERE EXISTS (SELECT 1 FROM cohort p WHERE p.inpat_id=e.inpat_id)
  )`
}

function aggregateSql(ctes: string): string {
  return `/* history:summary */ WITH ${ctes}, retained_reasons AS (
    SELECT r.execution_pathway_id,r.is_variation FROM cp_execution_records_reason r
    WHERE r.cur_hospital_code=$1 AND r.reason_type IN (0,1,2,4)
      AND EXISTS (SELECT 1 FROM selected_executions e WHERE e.id=r.execution_pathway_id)
  ) SELECT jsonb_build_object(
    'admissionCount',(SELECT count(DISTINCT p.inpat_id) FROM cohort p),
    'executionCount',(SELECT count(*) FROM selected_executions),
    'admissionsWithoutExecutionCount',(SELECT count(DISTINCT p.inpat_id) FROM cohort p
      WHERE NOT EXISTS (SELECT 1 FROM selected_executions e WHERE e.inpat_id=p.inpat_id)),
    'notIncludedCount',(SELECT count(*) FROM selected_executions WHERE execution_status=0),
    'underwayCount',(SELECT count(*) FROM selected_executions WHERE execution_status=1),
    'exitCount',(SELECT count(*) FROM selected_executions WHERE execution_status=2),
    'systemMarkedCompleteCount',(SELECT count(*) FROM selected_executions WHERE execution_status=3),
    'offPathwayTreatmentCount',(SELECT count(*) FROM selected_executions WHERE execution_status=4),
    'unknownExecutionStatusCount',(SELECT count(*) FROM selected_executions WHERE execution_status IS NULL OR execution_status NOT IN (0,1,2,3,4)),
    'unknownExecutionDeletedFlagCount',(SELECT count(*) FROM selected_executions WHERE is_deleted IS NULL),
    'unknownTreatmentPackageFlagCount',(SELECT count(*) FROM selected_executions WHERE is_treatment_package IS NULL),
    'currentReasonCount',(SELECT count(*) FROM retained_reasons),
    'reasonVariationTrueCount',(SELECT count(*) FROM retained_reasons WHERE is_variation=true),
    'reasonVariationFalseCount',(SELECT count(*) FROM retained_reasons WHERE is_variation=false),
    'reasonVariationUnknownCount',(SELECT count(*) FROM retained_reasons WHERE is_variation IS NULL),
    'executionsWithoutRetainedReasonCount',(SELECT count(*) FROM selected_executions e
      WHERE NOT EXISTS (SELECT 1 FROM retained_reasons r WHERE r.execution_pathway_id=e.id))
  ) AS data`
}

const diagnosesSql = `/* history:diagnoses */ SELECT jsonb_build_object(
  'id',d.id::text,'inpatId',d.inpat_id::text,'hospitalCode',d.cur_hospital_code,'diagnosisType',d.diag_type,
  'diagnosisTypeName',d.diag_type_name,'diagnosisCode',d.diag_code,'diagnosisName',d.diag_name,'icdCode',d.icd_code,'icdName',d.icd_name,
  'isMain',d.is_main_diag,'isSuspected',d.is_suspected,'isDeleted',d.is_deleted,'isCurrent',d.is_current,
  'diagnosedAt',d.diag_date,'modifiedAt',d.oper_time) AS data
  FROM cpoe_diagnose_record d WHERE d.cur_hospital_code=$1
    AND d.inpat_id IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb)) ORDER BY d.inpat_id,d.id LIMIT $3`

const reasonsSql = `/* history:reasons */ SELECT jsonb_build_object(
  'id',r.id::text,'hospitalCode',r.cur_hospital_code,'executionId',r.execution_pathway_id::text,
  'executionNodeId',r.execution_node_id::text,'executionItemId',r.execution_item_id::text,'reasonType',r.reason_type,
  'reasonId',r.reason_id::text,'otherReason',r.other_reason,'isVariation',r.is_variation,'createdAt',r.create_time) AS data
  FROM cp_execution_records_reason r WHERE r.cur_hospital_code=$1 AND r.reason_type IN (0,1,2,4)
    AND r.execution_pathway_id IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb)) ORDER BY r.execution_pathway_id,r.id LIMIT $3`

const itemsSql = `/* history:item-executions */ SELECT jsonb_build_object(
  'id',i.id::text,'hospitalCode',i.cur_hospital_code,'executionId',i.exec_id::text,
  'nodeDefinitionId',i.execution_node_id::text,'itemId',i.item_id::text,'itemCode',i.item_code,'itemName',i.item_name,
  'itemClassCode',i.item_class_code,'createdAt',i.create_time) AS data
  FROM cp_clinical_pathway_item_execution_records i WHERE i.cur_hospital_code=$1
    AND i.exec_id IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb)) ORDER BY i.exec_id,i.id LIMIT $3`

const ordersSql = `/* history:orders */ SELECT jsonb_build_object(
  'orderId',o.order_id::text,'inpatId',o.inpat_id::text,'hospitalCode',o.cur_hospital_code,
  'executionId',o.cp_exec_id::text,'nodeDefinitionId',o.cp_node_id::text,'templateItemId',o.cp_source_project_id::text,
  'stateId',o.order_state_id,'isDeleted',o.is_deleted,'beginTime',o.begin_time,'endTime',o.end_time,'inputTime',o.input_time,
  'execTime',o.exec_time,'execNum',o.exec_num) AS data
  FROM cpoe_inpat_order o WHERE o.cur_hospital_code=$1
    AND o.inpat_id IN (SELECT value::bigint FROM jsonb_array_elements_text($2::jsonb))
    AND (o.cp_exec_id IN (SELECT value::bigint FROM jsonb_array_elements_text($3::jsonb))
      OR o.order_id IN (SELECT value::bigint FROM jsonb_array_elements_text($4::jsonb))) ORDER BY o.inpat_id,o.order_id LIMIT $5`

function keepBounded(result: QueryResult, name: string, source: ClinicalSourceRow[], limit: number): ClinicalSourceRow[] {
  const kept = source.slice(0, limit)
  result.collections[name] = kept
  if (source.length > limit) {
    result.truncated = true
    result.coverage.push(`${name}: returned ${limit} rows; more source rows exist. Narrow the cohort or read an individual encounter for supported details.`)
  }
  return kept
}

function identifiers(source: ClinicalSourceRow[], key: string): string[] {
  return source.map(row => z.string().parse(row[key]))
}

/**
 * Read aggregate counts for the complete authorized cohort and optional bounded evidence pages.
 * @param ctx - Authorized read-only transaction, scope and deployment bounds.
 * @param args - Validated time, diagnosis, execution and paging criteria; omitted execution filters retain admissions with no execution.
 * @returns Source-state counts and bounded collections; missing required sources fail instead of becoming zero counts.
 */
export async function readHistory(ctx: QueryContext, args: HistoryRequest): Promise<QueryResult> {
  const result = emptyResult()
  const ctes = cohortSql(ctx)
  const values = [...scopeValues(ctx), args.from, args.to, args.timeBasis, args.pathwayId ?? '', args.executionStatus ?? '',
    args.diagnosisCode ?? '', args.diagnosisSystem, args.diagnosisType ?? '', String(args.mainDiagnosisOnly)]
  const [aggregate, ...unexpected] = await rows(ctx, aggregateSql(ctes), values)
  if (aggregate === undefined || unexpected.length > 0) throw new Error('Historical cohort aggregate must return exactly one record.')
  for (const key of countKeys) result.measures[key] = z.number().int().nonnegative().parse(aggregate[key])
  result.coverage.push(
    'Counts cover the entire filtered cohort, not the returned page. Admission counts are distinct encounters; execution and reason counts are source rows. No clinical completion rate is calculated.',
    'Execution filters apply to the same execution record. Execution-based time uses record creation, not clinical start or completion. Pathway, execution-status or execution-time filters exclude admissions without a matching execution.',
    'Admission authorization always uses the configured admission window and current or discharge department. Requested time windows are half-open and use the connection time zone for source timestamps without a time zone.',
    'Execution and diagnosis membership use is_deleted IS NOT TRUE: false and NULL remain eligible. Executions with is_treatment_package=true are excluded; NULL remains eligible and is counted separately.',
    'Diagnosis membership applies only requested code, type and main-diagnosis filters. Suspected and is_current flags are not eligibility filters; diagnosis details retain all source states, including deleted records.',
    'Reasons are currently retained records, not an immutable variation history. Types 0, 1, 2 and 4 reference executions; type 3 is an approval rejection on a definition and is excluded. A missing retained reason is not proof of no variation.',
    'Historical pathwayId, pathwayCode and versionNo are retained from each execution; no current definition replaces that historical association.',
  )
  if (args.mode === 'summary') return result

  const limit = Math.min(args.limit, ctx.limits.maxRows)
  const admissions = keepBounded(result, 'admissions', await rows(ctx, `/* history:admissions */ WITH ${ctes}
    SELECT jsonb_build_object('inpatId',p.inpat_id::text,'inpatCode',p.inpat_code,'hospitalCode',p.cur_hospital_code,
      'stateCode',p.inpat_state_code,'inTime',p.in_time,'outTime',p.out_time,'currentDepartmentCode',p.current_dept_code,
      'dischargeDepartmentCode',p.out_dept_code,'dischargeDepartmentName',p.out_dept_name,'modifiedAt',p.oper_time) AS data
    FROM cohort p ORDER BY p.inpat_id LIMIT $14 OFFSET $15`, [...values, limit + 1, args.offset]), limit)
  if (result.truncated) result.nextOffset = args.offset + admissions.length
  if (admissions.length === 0) return result
  const admissionIds = JSON.stringify(identifiers(admissions, 'inpatId'))
  const childLimit = ctx.limits.maxRows
  keepBounded(result, 'diagnoses', await rows(ctx, diagnosesSql, [ctx.scope.hospitalCode, admissionIds, childLimit + 1]), childLimit)
  const executions = keepBounded(result, 'executions', await rows(ctx, `/* history:executions */ WITH ${ctes}
    SELECT jsonb_build_object('id',e.id::text,'hospitalCode',e.cur_hospital_code,'inpatId',e.inpat_id::text,'inpatCode',e.inpat_code,
      'pathwayId',e.pathway_id::text,'pathwayCode',e.pathway_code,'versionNo',e.version_no,'pathwayName',e.pathway_name,
      'status',e.execution_status,'createdAt',e.create_time,'modifiedAt',e.oper_time,'departmentCode',e.dept_code,
      'isDeleted',e.is_deleted,'isTreatmentPackage',e.is_treatment_package,'evaluationIds',e.evaluation_id) AS data
    FROM selected_executions e WHERE e.inpat_id IN (SELECT value::bigint FROM jsonb_array_elements_text($14::jsonb))
    ORDER BY e.inpat_id,e.id LIMIT $15`, [...values, admissionIds, childLimit + 1]), childLimit)
  result.coverage.push('Evidence collections cover only returned admissions and returned executions; each collection has its own row cap. Child truncation does not change whole-cohort counts or imply that omitted evidence is absent.')
  if (executions.length === 0) return result
  const executionIds = JSON.stringify(identifiers(executions, 'id'))
  const reasons = keepBounded(result, 'reasons', await rows(ctx, reasonsSql, [ctx.scope.hospitalCode, executionIds, childLimit + 1]), childLimit)
  const items = keepBounded(result, 'itemExecutions', await rows(ctx, itemsSql, [ctx.scope.hospitalCode, executionIds, childLimit + 1]), childLimit)
  const orderIds = new Set<string>()
  for (const reason of reasons) {
    if (reason.reasonType === 2 && reason.executionItemId !== null) orderIds.add(z.string().parse(reason.executionItemId))
  }
  for (const item of items) {
    if (item.itemId !== null) orderIds.add(z.string().parse(item.itemId))
  }
  keepBounded(result, 'orders', await rows(ctx, ordersSql,
    [ctx.scope.hospitalCode, admissionIds, executionIds, JSON.stringify([...orderIds]), childLimit + 1]), childLimit)
  result.coverage.push(
    'itemExecutions.itemId and type-2 reasons.executionItemId are order IDs in verified service writes, not template-item IDs. Orders also retain cp_exec_id, cp_node_id and cp_source_project_id associations.',
    'Order rows and execution markers are not evidence of complete clinical delivery. Node execution records, laboratory results, examinations and actual administration records are not supported here. evaluationIds remains the source comma-separated string.',
  )
  return result
}
