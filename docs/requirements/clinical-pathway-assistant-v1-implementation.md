# Clinical Pathway Assistant V1 Implementation Plan

English | [中文](clinical-pathway-assistant-v1-implementation.zh.md)

Status: read tools and reference workflows are locally deployed as of 2026-10-26, with synthetic technical verification against the [PRD](clinical-pathway-assistant-v1.md). Approved development reads and a live-entry management-review reference demonstration pass; clinical quality and independent user acceptance remain pending. Read-only development metadata checks covered 19 tables/287 columns; no EMR/API or business-data change occurred.

## Summary

Implement one optional clinical-pathway composition in this project. `pathway_read` reads definitions, `history_query` selects historical cohorts and reports explicit aggregates, and `case_read` reads selected encounter evidence. Reuse the existing bounded PostgreSQL reader and Session/tool mechanisms where compatible. Deliver cited analyses and reference proposals; defer write APIs, business drafts, version commits, and approval integration to a future phase.

## Table of Contents

- [Ownership and tool definitions](#tools)
- [Table and field inventory](#tables)
- [Join rules and query semantics](#joins)
- [Implementation tasks](#tasks)
- [Verification and acceptance](#validation)
- [Compatibility and future integration](#future)
- [Dependencies and status](#status)
- [Dev Note](#dev-note)

<a id="tools"></a>
## Ownership and tool definitions

All implementation is owned by this repository: optional DSH plugins, server-side fixed-query execution, preset instructions, reference presentation, and Session records. No `emr-app`, Clinical Agent backend, pathway service, business API, or database schema modification is planned. EMR source remains the authority for interpreting its data model.

| Tool | Planned inputs and outputs | Query behavior |
| --- | --- | --- |
| `pathway_read` | Search or exact `pathwayId`; return series/version/state, departments, diagnoses, admission criteria, ordered nodes/branches, and supported item details. | Search is bounded; exact reads use the concrete definition ID, not a series code alone. Fetch child collections separately and assemble them without multiplying rows. |
| `history_query` | Authorized department/population, diagnosis criteria, explicit time field/window, optional pathway/version and source states, cohort/summary mode, and bounded paging; return counts, encounter/execution references, coverage, and definitions. | Start from admissions; use diagnosis/pathway `EXISTS` for cohort membership and separate child queries for details. Metrics use explicit distinct encounter and execution units. |
| `case_read` | Authorized `inpatId`, selected source categories/references, cursor/range; return original values/states/times and bounded readable content with coverage. | Reuse existing encounter/diagnosis/order/document SQL semantics, not the current-inpatient directory's scope restriction. Category selection and passage paging are new tool work, not current reader parameters. |

Use trusted configured hospital/history scope, a server-held account and fixed parameterized SQL in verified READ ONLY transactions. The default `select-only` policy requires a dedicated read role; the user approved `development-transaction-only` for the selected development target without changing source grants. The model cannot provide SQL, table/column names, connection settings, or credentials. Existing hosted infrastructure may carry the reader, but this does not add a hospital intermediary. Keep credentials outside model-readable private workspaces. No write tool, write route, migration, or new approval workflow belongs to this phase.

<a id="tables"></a>
## Table and field inventory

The inventory distinguishes source evidence from runtime verification. **S** means the project's existing [fixed SQL](../../packages/experimental/emr-reader-broker/src/sql.ts) and [directory SQL](../../packages/experimental/emr-reader-broker/src/directory.ts). **M** means explicit PostgreSQL `ToTable`/`HasColumnName` mappings in `Synyi.CPOE.Model 2.0.1815-pg-develop`, the package referenced by the inspected pathway service; its source file is [CPOEPgDbContext.cs](http://git.sy/Apollo/emr/backend/synyi-cpoe-model/-/blob/pg_develop/src/Synyi.CPOE.Model/CPOEPgDbContext.cs). **H** means the pathway service's [herbal-table DDL](http://git.sy/Apollo/emr/backend/synyi-emr-clinicalpathway/-/blob/pg_develop/scripts/postgresql/add_clinical_pathway_herbal_recipe.sql). Local records bind source revisions and target development metadata. Columns in the 19 tables actually used were checked; the candidate node-execution table still does not establish clinical completion.

### `pathway_read`: definitions

The following are business joins verified in mapping and DAL code. They are not claims that every legacy relation has a database foreign-key constraint. Read supported branches/prescriptions without flattening away order or grouping.

| Table | Required field groups | Key and relationship | Evidence |
| --- | --- | --- | --- |
| `cp_clinical_pathway` | `id`, `pathway_code`, `pathway_name`, `version_no`, `state_code`, `cur_hospital_code`, `dept_code`, `dept_name`, `days_lower_limit`, `days_upper_limit`, `fee_lower_limit`, `fee_upper_limit`, `is_deleted`, `is_branch_path`, `is_treatment_package`, `oper_time`. | PK `id` is one concrete version; `pathway_code` groups a series. | M |
| `cp_clinical_pathway_dept` | `id`, `clinical_pathway_id`, `dept_code`, `dept_name`, `cur_hospital_code`. | `clinical_pathway_id → cp_clinical_pathway.id`; using departments differ from the definition's owning department. | M |
| `cp_clinical_pathway_diagnostic_groups` | `id`, `clinical_pathway_id`, `diagnosis_code`, `diagnosis_name`, `copy_id`, `cur_hospital_code`. | `clinical_pathway_id → definition.id`; preserve the complete version-specific collection. | M |
| `cp_clinical_pathway_evaluate` | `id`, `clinical_pathway_id`, `evaluation_criteria`, `evaluation_type`, `is_required`, `basis_kind`, `basis_kind_name`, `cur_hospital_code`. | `clinical_pathway_id → definition.id`; interpret type with the service enum, not the conflicting mapping comment. | M |
| `cp_clinical_pathway_node` | `id`, `clinical_pathway_id`, `last_node_id`, `node_attribute`, `node_name`, `clinical_properties`, `days_lower_limit`, `days_upper_limit`, `is_exist_branch_path`, `branch_path_id`, `cur_hospital_code`. | `clinical_pathway_id → definition.id`; `last_node_id` links the predecessor. Do not infer sequence from ID order alone. | M |
| `cp_branch_path` | `id`, `node_id`, `cpid`, `clinical_properties`, `cur_hospital_code`. | `node_id → node.id`; `cpid → branch definition.id`. The physical column is `cpid`, not `cp_id`; bound recursive branch traversal and detect cycles. | M |
| `cp_clinical_pathway_item` | Identity/category: `id`, `node_id`, `item_type`, `item_code`, `item_name`, `item_class_code`, `item_class_name`, `item_sub_class_code`, `item_sub_class_name`, `order_type_code`. Treatment fields: `drug_id`, `once_dose`, `dose_unit`, `frequency_code`, `frequency_name`, `usage_code`, `usage_name`, `days`, `specs`, `base_unit_name`, `min_unit_name`, `pack_unit_name`. | `node_id → node.id`; these are template items, not orders or proof of execution. | M |
| `cp_clinical_pathway_item` continued | `exec_dept_code`, `exec_dept_name`, `is_required`, `is_repeatable`, `is_multiple_choice`, `is_apply_order`, `group_code`, `operation_apply_id`, `template_code`, `remark`, `group_sign`, `group_flag`, `group_sn`, `group_package_flag`, `group_package_sn`, `group_sort`, `cur_hospital_code`, `usage_type_code`, `usage_type_name`, `is_once_dose_change`, `test_is_group`, `is_self`. | Retain clinical conditions, document/application associations, and group/pack order; do not merge unlike item categories. | M |
| `cp_clinical_pathway_item_operation` | `id`, `item_id`, `operation_code`, `operation_name`, `operation_code2`, `cur_hospital_code`. | `item_id → template item.id`; optional operation-detail rows. | M |
| `cp_clinical_pathway_item_dic` | `id`, `cur_hospital_code`, `dept_code`, `item_type`, `item_code`, `item_name`, `clinical_pathway_item_name`. | Optional dictionary interpretation, not evidence of a complete drug/lab/examination catalog or a global FK by `item_code` alone. | M |
| `cp_herbal_recipe` | `item_id`, `cur_hospital_code`, `order_name`, `order_type_code`, `exec_dept_code`, `exec_dept_name`, `drug_count`, `decoct_count`, `usage_code`, `usage_name`, `usage_code2`, `usage_name2`, `frequency_code`, `frequency_name`, `decoction_code`, `decoction_name`, `rules_treatment_name`, `note`, `special_usage_code`, `special_usage_name`, `is_decoction`, `is_prescription`, `is_out_pat`, `herb_type_code`, `decoction_dosage`, `decoction_times`, `rate_code`, `rate_name`. | PK/FK `item_id → template item.id`; load for supported whole-prescription items (`item_class_code='24'`). | H |
| `cp_herbal_recipe_detail` | `id`, `item_id`, `sort`, `cur_hospital_code`, `drug_id`, `drug_code`, `drug_name`, `order_sub_class_code`, `order_sub_class_name`, `specs`, `qty`, `once_dose`, `dose_unit_code`, `dose_unit_name`, `dosage_code`, `dosage_name`, `base_dose`, `base_unit_code`, `base_unit_name`, `send_unit_code`, `send_unit_name`, `send_pack_qty`, `usage_code`, `usage_name`, `usage_code2`, `usage_name2`, `min_unit_code`, `min_unit_name`, `pack_unit_code`, `pack_unit_name`, `pack_qty`, `unit_sort`, `note`, `herb_type_code`. | `item_id → recipe.item_id`; DDL declares unique `(item_id, sort)`; retain ingredient sequence and units. Verify installation before use. | H |

### `history_query`: cohorts and recorded execution

Build population membership from admissions, then read diagnosis/execution children. A never-enrolled encounter must not disappear because it lacks a pathway row. Use the actual version associated with each execution.

| Table | Required physical fields | Relationship and interpretation | Evidence |
| --- | --- | --- | --- |
| `cpoe_inpat_record` | `inpat_id`, `inpat_code`, `cur_hospital_code`, `is_valid`, `inpat_state_code`, `in_time`, `out_time`, `current_dept_code`, `out_dept_code`, `out_dept_name`, `oper_time`. | Base cohort; choose current or discharge department explicitly. Do not filter all history by current enrollment or states 4/5. | S, M |
| `cpoe_diagnose_record` | `id`, `inpat_id`, `cur_hospital_code`, `diag_type`, `diag_type_name`, `diag_code`, `diag_name`, `icd_code`, `icd_name`, `is_main_diag`, `is_suspected`, `is_deleted`, `is_current`, `diag_date`, `oper_time`. | Match `inpat_id` and hospital using `EXISTS`; hospital diagnosis codes and ICD codes are distinct filters. Preserve diagnosis type and status. | S, M |
| `cp_clinical_pathway_execution_records` | `id`, `cur_hospital_code`, `inpat_id`, `inpat_code`, `pathway_id`, `pathway_code`, `version_no`, `pathway_name`, `execution_status`, `create_time`, `oper_time`, `dept_code`, `is_deleted`, `is_treatment_package`, `evaluation_id`. | Hospital + `inpat_id → admission`; `pathway_id → concrete definition.id`. Multiple rows can belong to one encounter; `evaluation_id` is a comma-separated assessment-ID string, not a scalar FK. | M |
| `cp_execution_records_reason` | `id`, `cur_hospital_code`, `execution_pathway_id`, `execution_node_id`, `execution_item_id`, `reason_type`, `reason_id`, `other_reason`, `is_variation`, `create_time`. | Resolve the overloaded parent by reason type before joining. Patient reasons associate with execution ID; audit rejection associates with definition ID. Preserve nullable variation flags. | M + service writes |
| `cp_clinical_pathway_item_execution_records` | `id`, `cur_hospital_code`, `exec_id`, `execution_node_id`, `item_id`, `item_code`, `item_name`, `item_class_code`, `create_time`. | `exec_id → execution.id`; verified code compares `execution_node_id` to definition node ID and writes order ID into `item_id`. Never join `item_id` directly to a template item. | M + service writes |
| `cpoe_inpat_order` | `order_id`, `inpat_id`, `cur_hospital_code`, `cp_exec_id`, `cp_node_id`, `cp_source_project_id`, `order_state_id`, `is_deleted`, `begin_time`, `end_time`, `input_time`, `exec_time`, `exec_num`. | `cp_exec_id → execution.id`; `cp_node_id → definition node.id`; verified pathway reads compare `cp_source_project_id` with template item ID. State/time fields retain order semantics. | S, M + service reads |
| `cp_clinical_pathway_node_execution_records` | `id`, `cur_hospital_code`, `execution_pathway_id`, `node_id`, `node_status`, `execution_begin_time`, `execution_end_time`, `create_time`. | Mapped candidate only; current DAL use and actual maintenance/completeness are not established. Do not depend on this table for task-completion claims until verified. | M only |

Optional reason dictionaries such as `cp_variation_reason` may explain verified reason codes after their columns/scope are checked. `cp_variation_immunity_item` is configuration, not a patient variation-event log; it cannot replace `cp_execution_records_reason`.

### `case_read`: encounter evidence

The strongest current evidence is the project's fixed SQL. It supplies admission, diagnosis, order, and persisted document-text categories; it does not establish a complete medical-record or execution warehouse.

| Table | Selected physical fields | Relationship and read limitation | Evidence |
| --- | --- | --- | --- |
| `cpoe_inpat_record` | `inpat_id`, `inpat_code`, `cur_hospital_code`, `is_valid`, `inpat_state_code`, `inpat_state_name`, `in_time`, `out_time`, `current_dept_code`, `out_dept_code`, `out_dept_name`, `source_inpat_id`, `source_inpat_no`, `sex_code`, `sex_name`, `age`, `age_unit`, `birth_date`, `discharge_mode_code`, `discharge_situation_code`, `oper_time`, `etl_time`. | Resolve exact `inpat_id` within authorized hospital/history scope; display only fields needed for analysis. | S, M |
| `cpoe_diagnose_record` | `id`, `inpat_id`, `cur_hospital_code`, `diag_type`, `diag_type_name`, `diag_code`, `diag_name`, `icd_code`, `icd_name`, `is_main_diag`, `is_suspected`, `is_deleted`, `is_current`, `diag_date`, `oper_time`. | Query separately by the same `inpat_id` + hospital; retain suspected/deleted/current flags rather than treating every row as a current confirmed diagnosis. | S |
| `cpoe_inpat_order` | `order_id`, `inpat_id`, `cur_hospital_code`, `cp_exec_id`, `cp_node_id`, `cp_source_project_id`, `order_name`, `order_type_code`, `order_class_code`, `order_state_id`, `is_deleted`, `begin_time`, `end_time`, `input_time`, `exec_time`, `exec_num`, `state_change_reason`, `is_out_pat`, `rowversion`, `drug_code`, `drug_name`, `once_dose`, `dose_unit_name`, `frequency_code`, `frequency_name`, `usage_code`, `usage_name`. | Query by `inpat_id` + hospital; `exec_time/exec_num` are not a full administration/execution feed. Existing SQL has no order `available_at` value. | S, M |
| `cpoe_inpat_medical_record` | `id`, `inpat_id`, `record_name`, `folder_code`, `template_code`, `record_date`, `record_state_code`, `record_state_name`, `is_draft`, `sign1_time`, `sign2_time`, `sign3_time`, `oper_time`. | Join to admission by `inpat_id` to apply hospital/validity scope; metadata/signatures do not substitute for readable body text. | S |
| `cpoe_inpat_medical_record_content` | `id`, `record_id`, `record_text`, `file_version`, `record_text_md5`, `oper_time`. | LEFT JOIN `record_id → medical_record.id`. A record can have multiple content rows; preserve `recordId:contentId` identity. NULL/empty text is unreadable, not proof of no document. | S |

MedicalDocument source also uses model property `RecordFile` and object-storage content referenced through `RecordBase64`; native FormV2 fields may live elsewhere. Those sources are not automatically available through this three-tool table reader. Start with actual `record_text` coverage and report gaps; adding file/form/report adapters is a later explicit scope change. Labs, examinations, operations, and administration are unsupported until their physical mappings and evidence semantics are separately verified.

<a id="joins"></a>
## Join rules and query semantics

These rules are required to prevent plausible but incorrect joins and statistics. They belong to fixed tool code and source-specific result labels, not model-written SQL.

| Subject | Required interpretation |
| --- | --- |
| Scope and schema | Apply explicit authorized hospital and approved shared/standard-hospital rules; SQL does not inherit the model's EF query filters. Verify schema/search path and each required column before enabling the tool. |
| Definition state | Source enum: 0 unreviewed, 1 in review, 2 rejected, 3 approved, 4 published. Existing list code uses `is_deleted IS NULL`, while mapping comments describe false/null as active; verify actual data before choosing a filter and report the adopted rule. |
| Admission/time basis | States 4/5 describe current inpatients; 6/7 describe discharge/departure in the inspected model. Choose admission, discharge, or enrollment time explicitly, with a documented half-open interval `[start,end)` and database/timezone interpretation. Current and discharge departments are different criteria. Selected-pathway `EXISTS` or execution-time filters exclude admissions without a matching record/timestamp. Define never-enrolled comparison cohorts separately by admission/discharge windows with separate denominators; state-0 records still mean not enrolled. |
| Diagnosis types | Inspected meanings include 10 admission, 14 current, and 31 discharge diagnoses. Main/suspected/deleted/current criteria are explicit filters; use `EXISTS` so multiple diagnoses do not inflate encounters. |
| Enrollment membership | Do not use `is_clinical_pathway=true` as history: exit/completion clears the current flag. Keep no-row, not-enrolled, non-pathway-treatment, ongoing, withdrawn, and system-completed groups distinct. |
| Execution state | Enum: 0 not enrolled, 1 ongoing, 2 withdrawn, 3 completed, 4 non-pathway treatment. These are source-state counts; neither `status != 0` nor enrolled-minus-withdrawn is a verified clinical completion denominator. |
| Execution time | `create_time` records creation/enrollment or non-enrollment; `oper_time` is an operation timestamp also changed on exit/completion, not a dedicated endpoint. Do not infer unsupported elapsed intervals from it. |
| Reason parents | Types 0/1/2/4 are patient-side non-enrollment/withdrawal/outside-pathway-order variation/patient variation, associated with execution records. Type 3 is audit rejection and can point to a definition ID. Filter type before joining; `is_variation` NULL stays unknown. Reason updates delete older rows; the table holds retained records, not a complete event stream. Counts cannot be called cumulative historical variation events. |
| Order/template linkage | Prefer verified `cp_exec_id/cp_node_id/cp_source_project_id` relations. In the inspected item-execution write path, `item_id` is an order ID; reason type 2's `execution_item_id` also uses an order ID. Other categories require their own evidence, not guessed FKs. |
| Admission assessment | The pathway service enum uses 0 inclusion and 1 exclusion, despite conflicting mapping comments. Preserve criteria and declared types; do not reinterpret them from comments alone. |
| Item/node semantics | `item_type`: 0 order, 1 document, 2 nursing. `node_attribute`: 0 inpatient day, 1 surgery day, 2 discharge day. Record existence and UI `ExecStatus` do not establish task performance. |
| Definition fan-out | Fetch diagnoses, criteria, nodes, branches, items, and related prescriptions as bounded collections; flattening all joins together duplicates data and corrupts counts. Bound branch depth/count and retain group/ingredient order. |
| Documents and versions | Preserve all returned record/content identities and states. Do not choose a latest content row by string sorting `file_version` without a verified version rule. Missing text does not trigger object-store or FormV2 access automatically. |
| Consistency and coverage | Reuse per-call `REPEATABLE READ READ ONLY` where compatible. Separate pages/tools may see different snapshots; show read time, filters, returned counts, truncation, and source changes instead of claiming one global snapshot. |

### Required measures

`history_query` reports distinct encounter count, execution-record count, counts by the declared source execution state, and recorded reason/missing-evidence counts. Every rate names its numerator and denominator, including handling of never-enrolled and non-pathway-treatment records. A source-completed count may be reported as system-marked completion; clinical task-completion rates require verified execution evidence not established by the current reader. Existing XLSX formulas are not adopted as the authoritative new calculation.

<a id="tasks"></a>
## Implementation tasks

The table retains repository implementation tasks and completion criteria; actual status is in [Dependencies and status](#status). EMR/backend schema migrations and write-endpoint development are excluded.

| Task | Scope and code anchors | Dependencies and acceptance evidence | Failure/recovery and coordination |
| --- | --- | --- | --- |
| T0: Verify read target and data meanings | Check exact database/schema, read-only role, permitted history scope, source mappings, optional tables, nullable states, and time/department definitions. Bind evidence to source/package versions. | First dependency for live reads; deliver a verified schema/field matrix and approved sample/metric scope. No patient rows are needed to identify metadata. | Missing optional sources stay unsupported; missing mandatory columns block the affected tool. Connections use the already approved scope; additional account/grant configuration is separate, with no automatic schema repair. |
| T1: Add a scoped fixed-query provider | Reuse or narrowly extract [database.ts](../../packages/experimental/emr-reader-broker/src/database.ts); retain read-only transactions, parameter binding, limits, timeout/cancellation, and server-held credentials. Register optional tools only in the pathway preset. | Depends on T0's configuration agreement; synthetic work may proceed before live access. Prove arbitrary SQL/identifiers and unauthorized scopes cannot be supplied and writes cannot execute. | Keep current insurance-review queries/policy intact. Unload cancels pending work; denied/unavailable reads produce bounded errors without credential output. |
| T2: Implement `pathway_read` | Use the definition inventory and a separate query module; assemble exact-version components, branches, operation details, and supported herbal content. | Depends on T1 and the verified definition subset; can run alongside T3 only with separate query modules and fixtures. Version, order, groups, and optional gaps round-trip in tests. | Partial/unsupported definition content is labeled; no fallback to another version or unbounded recursive query. |
| T3: Implement `history_query` and `case_read` | Separate cohort/aggregation and evidence query modules; reuse [sql.ts](../../packages/experimental/emr-reader-broker/src/sql.ts) semantics where compatible, adding history scope, selectable categories, and bounded reads. | Depends on T1 and verified source subsets; implement coupled cohort/encounter identity logic under one owner. Prove deduplicated cohorts, actual version links, overloaded-ID handling, readable-text limits, and explicit unsupported categories. | Failed/partial reads preserve prior evidence, never become zero counts or clinical absence. No raw-SQL or source-switch fallback. |
| T4: Compose reference analysis | Update [preset instructions](../../deploy/hosted-workspaces/clinical-pathway.preset.yml), tool presentation, Session records/projections, and the minimal pathway/reference view. Retain data filters, evidence, proposal revisions, and reference-only labels. | Depends on T2/T3 and agreed tool examples; non-coupled presentation work may start from synthetic outputs. Analyze an existing version and generate/edit a new reference without a business write. | Context switches cannot repaint another target; previous artifacts survive failures/reloads. Reuse existing UI components/slots before adding any neutral extension. |
| T5: Validate and document | Focused provider/tool tests, real Loader/preset composition, keyless Session replay, browser flow if UI changes, affected build/type/lint/docs checks, and updated package/JSDoc/user guidance. | Depends on T1–T4. Cover the PRD scenarios with synthetic fixtures, including invalid reads, join fan-out, ID misuse, missing text, and source-state versus completion claims. | Backend/API compatibility is read-only. No coverage claim for unsupported execution/report sources; record exact commands/results and remaining gaps. |
| T6: Authorized read-only acceptance | Verify deployment composition and read configuration, then use permitted development samples to demonstrate selected-pathway analysis and new/revised reference generation. | Depends on T5, deployment authorization, a connection satisfying read-only checks, and an independent user acceptance owner. Record expected/actual/pass-fail results and coverage. | Disable the optional feature to withdraw access, preserving private Session/reference records. No business rollback is needed because no business writes occur. |

T2 and T3 may run in parallel after the shared query interface is fixed and their edit ownership is separate. T4's state/proposal logic has one owner; test examples are jointly reviewed before use. There is no prerequisite to change hospital APIs or complete future write semantics before this phase can pass.

<a id="validation"></a>
## Verification and acceptance

Validate query behavior and analysis usefulness separately. Planned code checks are not evidence of live database support until executed against the exact authorized target.

| Verification group | Required evidence |
| --- | --- |
| Read-only enforcement | Real relational test connection denies mutations; fixed tools reject SQL fragments/table names, wrong hospital/scope, excessive bounds, timeout, and cancelled reads. |
| Definition assembly | Multiple diagnoses/criteria/items, branches/cycles, groups, operation details, and optional whole-prescription fixtures preserve the exact version and ordering without row multiplication. |
| Historical joins | Fixtures include never-enrolled encounters, multiple diagnoses/executions, source states 0–4, audit reason type 3, order-ID item records, and department/time edges. Counts and links match explicit expectations. |
| Evidence coverage | Multiple content versions, missing/empty text, unsigned/draft/deleted/suspected states where supported, and unsupported reports/execution remain distinguishable and cannot become fabricated absence/completion. |
| DSH composition and replay | Real Loader/profile registers three tools only for the pathway preset, logs model-visible results, restores references after reload, disposes registrations, and rejects wrong-target/fork authority. Use synthetic data in replay and any GUI recording. |
| Reference quality | Users can inspect scope/evidence and edit a labeled proposal; no hospital draft/version appears, and no write/review/publication endpoint is invoked. Lack of guidelines produces explicit questions rather than invented care standards. |

After code changes, run the smallest affected behavior tests, required recorded-session snapshots, `build:artifacts` then `build:check`, and affected lint/documentation checks. Real data/model integration, synthetic tests, deployment, and human acceptance are reported separately. This implementation runs fixed SQL in isolated PostgreSQL, real HTTP/Loader tests, scripted multi-turn reference revisions, cross-process Session restoration and snapshot replay. Live development verification also exercises the actual provider/HTTP client and a bounded document passage; only counts, coverage and a digest are retained in its report. The delivery evidence below records the local live-model demonstration separately from clinical quality and independent user acceptance.

<a id="future"></a>
## Compatibility and future integration

Business tables, existing EMR interfaces, published pathway versions, and insurance-review behavior remain unchanged. New durable data is limited to DSH-owned evidence/reference records. Schema-version any new plugin records and acknowledge persistence/SDK consequences if implementation changes shared types; do not rewrite released Session generations. Disabling the optional plugin preserves existing private reference artifacts and other presets.

A later writer can consume the selected target/baseline, reference revision, differences, and evidence after a new scope review. It must separately establish confirmation, authorization, save/version semantics, conflicts, retries, and original-system handoff. Do not build that client, its server endpoints, hospital migrations, or commit-receipt storage in this phase. No preliminary API changes are required merely to generate reference plans now.

<a id="status"></a>
## Dependencies and status

T1–T4 are implemented, with technical evidence for read-only acquisition, grant revocation, reference v1 → user edit → v2, target changes and cross-process restoration. T5 records the affected checks; T6 includes local deployment and a live-entry demonstration, with remaining acceptance scope listed below. T0 verifies the development schema and user-selected test department/last-year scope. The user approved reusing the existing account under fixed SQL and enforced read-only transactions; six provider/client reads pass without source writes or role changes. Unverified source categories stay explicit limitations; adding reliable execution/lab/form/file sources requires its own mapping and scope decision.

The EMR-side work is source/schema clarification and permitted read access, not code delivery. Physical mappings come from fixed SQL, the model package, optional-table DDL and actual read-only development metadata checks; none substitutes for real-sample analysis or clinical validation. The approved output is reference analysis and proposal generation only.

| Delivery evidence | Observed result |
| --- | --- |
| Focused regression and package coverage | 241 tests pass; the new package has 100% statements, branches, functions and lines. The 11 PostgreSQL cases run separately. |
| Isolated PostgreSQL | 11 cases pass, including development-role reads and rejected DML with unchanged source values. |
| Development source | Six bounded provider/client requests pass within the approved scope, including a document passage checked by length/digest; no source writes or grant changes. |
| Reference workflow and UI | Two Session replays and one real Web regression pass; three-turn reference revisions and cross-process restoration are covered. |
| Local live-entry demonstration | The live model reads definitions and historical summaries/cohorts, saves a v1 management-review reference, and revises it to three checks as v2 in the same chat. The v1 file remains; the second turn makes no further tool, database or file calls. Both turns and the v1 file remain after refresh. |
| Build and lint | Artifact build and both aggregate checks pass; lint passes with an existing unused-disable warning outside this feature. |
| Repository checks | Documentation: 42 pass, with the existing uv.lock commit-reference failure. Hygiene: 19 pass, with existing theme-reference and vendor-rescope failures. Duplication retains one unchanged pre-existing client-wrapper clone. |
| Delivery limits | Locally deployed; no commit or push. New clinical-pathway proposal generation, model-invoked `case_read`, clinical quality, and independent user acceptance remain unverified. |

<a id="dev-note"></a>
## Dev Note

Source reading covered this project's [SQL](../../packages/experimental/emr-reader-broker/src/sql.ts), [reader coverage](../../packages/experimental/emr-reader-broker/src/reader.ts), and [read transaction](../../packages/experimental/emr-reader-broker/src/database.ts), plus the pathway service's [execution writes/reads](http://git.sy/Apollo/emr/backend/synyi-emr-clinicalpathway/-/blob/pg_develop/src/Synyi.Emr.ClinicalPathway.Dal/Dal/ClinicalPathwayExecuteDal.cs), [historical statistics](http://git.sy/Apollo/emr/backend/synyi-emr-clinicalpathway/-/blob/pg_develop/src/Synyi.Emr.ClinicalPathway.Dal/Dal/VariationImmunityItemDal.cs), and [state enums](http://git.sy/Apollo/emr/backend/synyi-emr-clinicalpathway/-/tree/pg_develop/src/Synyi.Emr.ClinicalPathway.Model/Enums). NuGet source identity and document verification are retained in local records; development metadata and bounded source reads were verified without exposing credentials, retaining patient identifiers/body text in reports, or changing business tables/roles.
