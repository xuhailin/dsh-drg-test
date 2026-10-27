/** Per-transaction schema and dedicated read-role checks for fixed pathway queries. */
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import type { ReadTransaction } from '@deepseek-ai/dsh-experimental-emr-reader-broker'
import { z } from 'zod'
import type { QueryLimits } from './protocol.ts'

const requiredColumns = {
  cp_clinical_pathway: 'id pathway_code pathway_name version_no state_code cur_hospital_code dept_code dept_name days_lower_limit days_upper_limit fee_lower_limit fee_upper_limit is_deleted is_branch_path is_treatment_package oper_time',
  cp_clinical_pathway_dept: 'id clinical_pathway_id dept_code dept_name cur_hospital_code',
  cp_clinical_pathway_diagnostic_groups: 'id clinical_pathway_id diagnosis_code diagnosis_name copy_id cur_hospital_code',
  cp_clinical_pathway_evaluate: 'id clinical_pathway_id evaluation_criteria evaluation_type is_required basis_kind basis_kind_name cur_hospital_code',
  cp_clinical_pathway_node: 'id clinical_pathway_id last_node_id node_attribute node_name clinical_properties days_lower_limit days_upper_limit is_exist_branch_path branch_path_id cur_hospital_code',
  cp_branch_path: 'id node_id cpid clinical_properties cur_hospital_code',
  cp_clinical_pathway_item: 'id node_id item_type item_code item_name item_class_code item_class_name item_sub_class_code item_sub_class_name order_type_code drug_id once_dose dose_unit frequency_code frequency_name usage_code usage_name days specs base_unit_name min_unit_name pack_unit_name exec_dept_code exec_dept_name is_required is_repeatable is_multiple_choice is_apply_order group_code operation_apply_id template_code remark group_sign group_flag group_sn group_package_flag group_package_sn group_sort cur_hospital_code usage_type_code usage_type_name is_once_dose_change test_is_group is_self',
  cp_clinical_pathway_execution_records: 'id cur_hospital_code inpat_id inpat_code pathway_id pathway_code version_no pathway_name execution_status create_time oper_time dept_code is_deleted is_treatment_package evaluation_id',
  cp_execution_records_reason: 'id cur_hospital_code execution_pathway_id execution_node_id execution_item_id reason_type reason_id other_reason is_variation create_time',
  cp_clinical_pathway_item_execution_records: 'id cur_hospital_code exec_id execution_node_id item_id item_code item_name item_class_code create_time',
  cpoe_inpat_record: 'inpat_id inpat_code cur_hospital_code is_valid inpat_state_code inpat_state_name in_time out_time current_dept_code out_dept_code out_dept_name source_inpat_id source_inpat_no sex_code sex_name age age_unit birth_date discharge_mode_code discharge_situation_code oper_time etl_time',
  cpoe_diagnose_record: 'id inpat_id cur_hospital_code diag_type diag_type_name diag_code diag_name icd_code icd_name is_main_diag is_suspected is_deleted is_current diag_date oper_time',
  cpoe_inpat_order: 'order_id inpat_id cur_hospital_code cp_exec_id cp_node_id cp_source_project_id order_name order_type_code order_class_code order_state_id is_deleted begin_time end_time input_time exec_time exec_num state_change_reason is_out_pat rowversion drug_code drug_name once_dose dose_unit_name frequency_code frequency_name usage_code usage_name',
  cpoe_inpat_medical_record: 'id inpat_id record_name folder_code template_code record_date record_state_code record_state_name is_draft sign1_time sign2_time sign3_time oper_time',
  cpoe_inpat_medical_record_content: 'id record_id record_text file_version record_text_md5 oper_time',
}

const herbalColumns = {
  cp_herbal_recipe: 'item_id cur_hospital_code order_name order_type_code exec_dept_code exec_dept_name drug_count decoct_count usage_code usage_name usage_code2 usage_name2 frequency_code frequency_name decoction_code decoction_name rules_treatment_name note special_usage_code special_usage_name is_decoction is_prescription is_out_pat herb_type_code decoction_dosage decoction_times rate_code rate_name',
  cp_herbal_recipe_detail: 'id item_id sort cur_hospital_code drug_id drug_code drug_name order_sub_class_code order_sub_class_name specs qty once_dose dose_unit_code dose_unit_name dosage_code dosage_name base_dose base_unit_code base_unit_name send_unit_code send_unit_name send_pack_qty usage_code usage_name usage_code2 usage_name2 min_unit_code min_unit_name pack_unit_code pack_unit_name pack_qty unit_sort note herb_type_code',
}
const operationColumns = { cp_clinical_pathway_item_operation: 'id item_id operation_code operation_name operation_code2 cur_hospital_code' }
const dictionaryColumns = {
  cp_clinical_pathway_item_dic: 'id cur_hospital_code dept_code item_type item_code item_name clinical_pathway_item_name',
  v_cpoe_drug: 'cur_hospital_code drug_code base_dose base_dose1 base_unit_name1 skin_test_flag',
}

const stateSchema = z.tuple([z.strictObject({
  schema: z.string().nullable(), read_only: z.string(), has_temp_schema: z.boolean(), unsafe_role: z.boolean(),
  time_zone: z.string().min(1).max(128),
})])
const privilegeSchema = z.array(z.strictObject({
  table_name: z.string(), readable: z.boolean(), writable: z.boolean(), owned: z.boolean(), schema_owned: z.boolean(),
}))
const missingSchema = z.array(z.strictObject({ table_name: z.string(), column_name: z.string() }))

const stateSql = `SELECT current_schema() AS schema,current_setting('transaction_read_only') AS read_only,
  current_setting('TimeZone') AS time_zone,
  pg_my_temp_schema()<>0 AS has_temp_schema,
  EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE
    (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
    AND pg_has_role(current_user,r.oid,'MEMBER')) AS unsafe_role`

const privilegeSql = `WITH expected AS (SELECT jsonb_array_elements_text($2::jsonb) AS table_name)
  SELECT expected.table_name,
    COALESCE(has_table_privilege(current_user,c.oid,'SELECT'),false) AS readable,
    COALESCE(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),false)
      OR COALESCE(has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'),false) AS writable,
    COALESCE(pg_has_role(current_user,c.relowner,'MEMBER'),false) AS owned,
    COALESCE(pg_has_role(current_user,n.nspowner,'MEMBER'),false) AS schema_owned
  FROM expected LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=$1
  LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=expected.table_name
    AND (c.relkind IN ('r','p') OR (expected.table_name='v_cpoe_drug' AND c.relkind='v'))`

const columnsSql = `WITH expected AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS e(table_name text,column_name text)
  ) SELECT expected.table_name,expected.column_name FROM expected
  LEFT JOIN information_schema.columns c ON c.table_schema=$1
    AND c.table_name=expected.table_name AND c.column_name=expected.column_name
  WHERE c.column_name IS NULL`

/**
 * Verify all enabled query sources before reading business rows in this transaction.
 * @param tx - A fresh read-only transaction owned by the gateway operation.
 * @param schema - Explicit lowercase PostgreSQL source-schema identifier.
   * @param limits - Supported optional sources and any explicitly approved development-role policy.
 * @returns The source connection timezone after every schema and transaction check succeeds.
 */
export async function verifySource(tx: ReadTransaction, schema: string, limits: QueryLimits): Promise<string> {
  if (schema.trim() !== schema || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw unavailable()
  const tables = {
    ...requiredColumns,
    ...(limits.herbalTables ? herbalColumns : {}),
    ...(limits.operationTables === true ? operationColumns : {}),
    ...(limits.dictionaryTables === true ? dictionaryColumns : {}),
  }
  const names = Object.keys(tables)
  const columns = Object.entries(tables).flatMap(([table_name, list]) => list.split(' ').map(column_name => ({ table_name, column_name })))
  try {
    await tx.query("SELECT set_config('search_path',$1,true)", [schema])
    const [state] = stateSchema.parse(await tx.query(stateSql, []))
    if (state.schema !== schema || state.read_only !== 'on' || state.has_temp_schema || state.unsafe_role) throw unavailable()
    const privileges = privilegeSchema.parse(await tx.query(privilegeSql, [schema, JSON.stringify(names)]))
    if (privileges.length !== names.length || new Set(privileges.map(row => row.table_name)).size !== names.length
      || privileges.some(row => !names.includes(row.table_name) || !row.readable
        || (limits.allowWritableDevelopmentRole !== true && (row.writable || row.owned || row.schema_owned)))) {
      throw unavailable()
    }
    const missing = missingSchema.parse(await tx.query(columnsSql, [schema, JSON.stringify(columns)]))
    if (missing.length > 0) throw unavailable()
    return state.time_zone
  } catch (error) {
    if (error instanceof EncounterReadError) throw error
    throw unavailable(error)
  }
}

function unavailable(cause?: unknown): EncounterReadError {
  return new EncounterReadError('source-unavailable',
    'Clinical source checks failed. Ask the operator to verify the source schema, required columns and read-only transaction/role policy.',
    cause === undefined ? undefined : { cause })
}
