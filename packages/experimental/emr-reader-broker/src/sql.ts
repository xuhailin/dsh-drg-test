/** Fixed PostgreSQL queries; caller values never become SQL identifiers or fragments. */
import type { EvidenceCategory } from '@deepseek-ai/dsh-experimental-emr-encounter'

/** The first query verifies admission identity inside the hospital scope. */
export const encounterIdentitySql = 'SELECT inpat_id::text AS id, inpat_code FROM cpoe_inpat_record WHERE inpat_id = $1::bigint AND cur_hospital_code = $2 AND is_valid = true LIMIT 2'

function bounded(body: string): string {
  return `WITH evidence AS (${body}), bounded AS (SELECT * FROM evidence ORDER BY id LIMIT $3) SELECT id, state, occurred_at, available_at, octet_length(body::text) > $4 OR sum(octet_length(body::text)) OVER () > $5 AS oversized, CASE WHEN octet_length(body::text) <= $4 AND sum(octet_length(body::text)) OVER () <= $5 THEN body ELSE NULL END AS body FROM bounded ORDER BY id`
}

/** Supported categories retain original values and source status without clinical inference. */
export const sourceQueries: readonly { category: EvidenceCategory; sql: string }[] = [
  { category: 'encounter', sql: bounded(`SELECT r.inpat_id::text AS id, r.inpat_state_code AS state, r.in_time::text AS occurred_at, r.oper_time::text AS available_at,
    jsonb_build_object('inpatId',r.inpat_id::text,'inpatCode',r.inpat_code,'sourceInpatId',r.source_inpat_id,'sourceInpatNo',r.source_inpat_no,
    'inTime',r.in_time,'outTime',r.out_time,'stateCode',r.inpat_state_code,'stateName',r.inpat_state_name,'sexCode',r.sex_code,'sexName',r.sex_name,
    'age',r.age,'ageUnit',r.age_unit,'birthDate',r.birth_date,'dischargeModeCode',r.discharge_mode_code,'dischargeSituationCode',r.discharge_situation_code,
    'modifiedAt',r.oper_time,'etlTime',r.etl_time) AS body
    FROM cpoe_inpat_record r WHERE r.inpat_id = $1::bigint AND r.cur_hospital_code = $2 AND r.is_valid = true`) },
  { category: 'diagnoses', sql: bounded(`SELECT d.id::text AS id, CASE WHEN d.is_deleted = true THEN 'deleted' WHEN d.is_suspected = true THEN 'suspected' ELSE 'recorded' END AS state,
    d.diag_date::text AS occurred_at, d.oper_time::text AS available_at,
    jsonb_build_object('diagnosisType',d.diag_type,'diagnosisTypeName',d.diag_type_name,'name',d.diag_name,'hospitalCode',d.diag_code,'icdCode',d.icd_code,'icdName',d.icd_name,
    'isMain',d.is_main_diag,'isSuspected',d.is_suspected,'isDeleted',d.is_deleted,'isCurrent',d.is_current,'diagnosedAt',d.diag_date,'modifiedAt',d.oper_time) AS body
    FROM cpoe_diagnose_record d WHERE d.inpat_id = $1::bigint AND d.cur_hospital_code = $2`) },
  { category: 'orders', sql: bounded(`SELECT o.order_id::text AS id, o.order_state_id::text AS state, o.begin_time::text AS occurred_at, NULL::text AS available_at,
    jsonb_build_object('name',o.order_name,'orderTypeCode',o.order_type_code,'orderClassCode',o.order_class_code,'stateId',o.order_state_id,'isDeleted',o.is_deleted,
    'beginTime',o.begin_time,'endTime',o.end_time,'inputTime',o.input_time,'execTime',o.exec_time,'execNum',o.exec_num,'rowversion',o.rowversion::text,
    'stateChangeReason',o.state_change_reason,'isOutPat',o.is_out_pat,'drugCode',o.drug_code,'drugName',o.drug_name,'onceDose',o.once_dose,'doseUnit',o.dose_unit_name,
    'frequencyCode',o.frequency_code,'frequencyName',o.frequency_name,'usageCode',o.usage_code,'usageName',o.usage_name) AS body
    FROM cpoe_inpat_order o WHERE o.inpat_id = $1::bigint AND o.cur_hospital_code = $2`) },
  { category: 'documents', sql: bounded(`SELECT r.id::text || ':' || COALESCE(c.id::text, 'missing') AS id,
    CASE WHEN c.record_text IS NULL OR c.record_text = '' THEN 'unreadable' WHEN r.is_draft = true THEN 'draft' ELSE COALESCE(r.record_state_code, 'recorded') END AS state,
    r.record_date::text AS occurred_at, GREATEST(r.oper_time, c.oper_time)::text AS available_at,
    jsonb_build_object('recordId',r.id::text,'contentId',c.id::text,'name',r.record_name,'folderCode',r.folder_code,'templateCode',r.template_code,'recordDate',r.record_date,
    'stateCode',r.record_state_code,'stateName',r.record_state_name,'isDraft',r.is_draft,'sign1Time',r.sign1_time,'sign2Time',r.sign2_time,'sign3Time',r.sign3_time,
    'recordModifiedAt',r.oper_time,'contentModifiedAt',c.oper_time,'fileVersion',c.file_version,'sourceTextDigest',c.record_text_md5,'text',c.record_text) AS body
    FROM cpoe_inpat_medical_record r JOIN cpoe_inpat_record p ON p.inpat_id = r.inpat_id
    LEFT JOIN cpoe_inpat_medical_record_content c ON c.record_id = r.id
    WHERE r.inpat_id = $1::bigint AND p.cur_hospital_code = $2 AND p.is_valid = true`) },
]
