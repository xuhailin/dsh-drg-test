# Clinical Pathway Assistant V1

English | [中文](clinical-pathway-assistant-v1.zh.md)

Status: read tools and reference workflows are locally deployed as of 2026-10-26. Synthetic technical checks, approved development reads, and a live-entry management-review reference demonstration pass; clinical quality and independent user acceptance remain pending. `clinical-pathway-analysis` supports pathway analysis and new/revised reference proposals. Business writes remain a separate future integration.

## Summary

Clinicians and pathway managers ask the assistant to analyze a selected pathway or produce a reference proposal for a new or revised pathway. Three tools read approved development data: `pathway_read`, `history_query`, and `case_read`. The assistant returns evidence, cohort definitions, coverage gaps, and proposed changes for human consideration. Code and composition belong to this project; no EMR frontend, backend, API, or business database schema change is required. The feature still depends on EMR tables, relationships, and business meanings.

## Table of Contents

- [Goals and scope](#scope)
- [User flow and reference outputs](#flow)
- [Three read-only tools](#tools)
- [Behavioral requirements](#requirements)
- [Acceptance scenarios](#acceptance)
- [Future write integration](#future)
- [Dependencies and status](#dependencies)
- [Dev Note](#dev-note)

<a id="scope"></a>
## Goals and scope

The outcome is an explainable analysis or editable reference document. A proposal does not create a hospital pathway, allocate a business version, or change care delivery.

| Item | Current requirement |
| --- | --- |
| Analyze a pathway | Identify the exact definition/version, inspect historical cohorts and recorded execution/variation, and explain findings with explicit denominators and missing evidence. |
| Generate a reference proposal | Support a new-pathway reference or revisions to an existing definition, using actual data and approved references; preserve existing content when presenting changes. |
| Project ownership | Implement tools, fixed SQL, analysis instructions, presentation, and Session records in this repository's optional clinical-pathway composition. EMR source is evidence for data interpretation, not an implementation target. |
| Data source | Use the user-specified `pg_develop` development database through a server-owned read-only connection and parameterized queries. Exact database/schema and permitted hospital/department/history scope must be verified before live reads. |
| De-identification | A new de-identification service is not a prerequisite. Read only fields needed for the approved analysis through the already approved model route; do not send patient content to public search or publish it in public examples. |
| Saved output | Retain analysis inputs, references, proposal revisions, and user edits in the private DSH Session or user-requested local reference files. These are reference artifacts, not hospital business drafts. |

The phase excludes business database writes, draft creation, version creation, record changes, patient enrollment, order placement/execution, review submission, publication, realtime monitoring, patient folders, and a new Clinical Agent intermediary. It does not require MCP infrastructure or a generic SQL tool. User review edits only the reference artifact; it grants no medical-system write authority.

<a id="flow"></a>
## User flow and reference outputs

The assistant organizes work by pathway/topic, with no patient-bound chat requirement. The user supplies the analysis objective, available pathway, department/population, and time range; existing information is reused rather than requested again.

1. For an existing pathway, call `pathway_read` to locate and read its exact version. For a new reference proposal, establish the intended population and available comparable definitions without pretending a business pathway already exists.
2. Call `history_query` with explicit hospital/department, diagnosis, period, and optional pathway/version filters. Show whether counts represent distinct encounters or pathway-execution records.
3. Call `case_read` only for selected relevant encounters, with bounded source categories/passages. Missing document text or unsupported execution/report sources remain visible gaps.
4. Produce findings or a reference proposal, showing data periods, source identities, sample/coverage limits, evidence, proposed changes, and questions requiring clinical judgment.
5. The user can discuss, edit, or request another reference revision. Label it as a reference proposal; do not claim it has been saved to, reviewed by, or published in the hospital system.

| Output | Required contents |
| --- | --- |
| Pathway analysis | Exact pathway/version, cohort filters and time basis, sample/record counts, source-state distribution, variation evidence, coverage, and findings. System-marked completion is distinct from verified clinical task completion. |
| New reference proposal | Intended population/exclusions, source material, candidate phases/windows/tasks/branches, rationale and citations, uncertainties, and human-review questions. Unsupported treatment requirements remain unresolved. |
| Revision reference | Baseline definition, before/after changes, reasons and evidence, preserved unchanged portions, proposal revision, and remaining questions. A proposal label such as v1/v2 is not a business-system version. |

Historical frequency is an observation, not a clinical standard. Guidelines and institutional requirements need actual accessible reference material. Read times and source revisions must be shown; separate tool calls are not represented as one immutable database snapshot.

<a id="tools"></a>
## Three read-only tools

These are the complete implemented DSH-native business tools for this phase. They require explicit reader activation and successful source checks; the local deployment enables the reader. Table/field/join details have one home in the [implementation plan](clinical-pathway-assistant-v1-implementation.md#tables).

| Tool | Inputs | Observable result |
| --- | --- | --- |
| `pathway_read` | Bounded search or exact version ID, optional series/version and requested definition sections; hospital/department access comes from trusted configuration. | Version-specific definition, diagnosis/admission conditions, ordered nodes, branches, items and supported related content, with identity/state and missing-component flags. |
| `history_query` | Authorized scope, explicit admission/discharge/enrollment time basis, period, diagnosis criteria, optional pathway/version and execution states, list/summary selection, and bounded paging. | Encounter cohort or clearly defined aggregates, separate encounter/execution counts, actual version associations, recorded reasons, source states, pagination/truncation, and gaps. |
| `case_read` | Authorized encounter ID, source categories/references, and bounded paging/passages. | Admission, diagnoses, orders, readable persisted document text, original source states/times, and explicit unreadable/unsupported coverage. |

Tool code selects fixed SQL and allowed columns. Model arguments never become SQL fragments, identifiers, credentials, or arbitrary database addresses. A dedicated SELECT-only account is the default; the approved development mode reuses the existing account while fixed SQL and enforced READ ONLY transactions preserve source data independently of prompts. There is no write tool in this phase.

<a id="requirements"></a>
## Behavioral requirements

The requirements below govern both pathway analysis and reference generation. Physical schema verification and clinical evidence interpretation are separate checks.

| ID | Requirement |
| --- | --- |
| CPA-01 | Distinguish analysis, new reference, and revision reference. Existing-pathway work binds an exact definition/version; switching targets cannot reuse another target's evidence as current. |
| CPA-02 | Provide only the three scoped read tools through `clinical-pathway-analysis`. Use fixed parameterized SQL, read-only transactions, explicit hospital scope, bounds, timeouts, and cancellation; expose no arbitrary SQL or business write capability. Dedicated SELECT-only credentials remain the default; the user explicitly approved reusing the existing development account in enforced read-only transactions. |
| CPA-03 | Verify the actual development database and necessary tables/columns before enabling reads. Missing or incompatible mappings fail visibly rather than querying another source or inventing records. |
| CPA-04 | Historical cohorts include eligible never-enrolled, completed, and withdrawn cases according to explicit filters; do not reuse current-inpatient-only permission or current-enrollment flags as historical membership. Cases without a matching execution record or selected timestamp do not belong to that execution cohort. Define never-enrolled comparison cohorts separately by admission/discharge windows with their own denominators. |
| CPA-05 | Count distinct encounters and execution records separately, preserving diagnoses and execution states. Define numerator/denominator, time basis, sampling, and missing data for every reported measure. |
| CPA-06 | Associate evidence with the actual pathway definition used at the time. Do not replace historical baselines with the current published version or join overloaded IDs by their names alone. |
| CPA-07 | Treat orders, charges, record existence, and system completion flags according to their source meanings; none alone proves every required clinical task was performed. |
| CPA-08 | Return only source content actually read, with references and times. Missing `record_text` is unreadable, not an absent medical record; unsupported labs/checks/execution remain unsupported. |
| CPA-09 | Separate observations, calculations, references, inference, and proposed changes. Every material data-based finding cites accessible evidence; unsupported clinical requirements remain questions. |
| CPA-10 | Retain model-visible query results and reference revisions in the private Session so analysis is reconstructable after reload. Query completion time does not imply a shared snapshot across tools/pages. |
| CPA-11 | Label outputs as reference analyses/proposals, preserve revision comparisons and user edits, and never claim a hospital draft/version/write/review/publication occurred. |
| CPA-12 | Failures preserve prior reference artifacts and report unavailable/partial/unknown coverage. Source access, cancellation, model generation, and reference persistence never modify business tables or trigger an automatic write fallback. |

<a id="acceptance"></a>
## Acceptance scenarios

Technical verification uses synthetic data first. Live development reads and independent user acceptance require the exact permitted data scope; source inspection alone does not establish runtime support.

| Scenario | Observable pass condition |
| --- | --- |
| Analyze a selected version | Display the correct definition, filters, evidence, and coverage; compare actual historical versions without mixing another pathway or version. |
| Generate a new reference | Use the requested population, including eligible never-enrolled history, and produce an explicitly labeled proposal without creating any pathway record. |
| Request revision suggestions | Show before/after changes and user edits while the hospital definition and publication state remain unchanged. |
| Multiple diagnoses/executions per encounter | Cohort counts do not multiply after joins; encounter counts and execution counts are separately identified, and non-pathway treatment is not silently counted as enrollment. |
| Overloaded IDs and reason types | Link execution, node, order, and audit-rejection records according to verified relationships; do not fabricate task evidence through a wrong join. |
| Missing text or unsupported sources | Show unreadable/unavailable/unsupported categories and partial coverage; do not claim full-record review or clinical completion. |
| Invalid scope, SQL input, or excessive query | Deny unauthorized scope and arbitrary SQL, enforce configured limits/cancellation, and verify the connection cannot write source data. |
| Refresh, failure, or incomplete data | Retain reconstructable inputs/proposals; show read times and partial scope without presenting multiple reads as one snapshot. |
| No adequate clinical reference | Present evidence limits and review questions rather than turning common historical practice into an approved care standard. |

<a id="future"></a>
## Future write integration

Writeback can be added later as a separately reviewed capability. Reference output keeps the target/baseline identity, proposal revision, differences, evidence, and data cutoff needed for that handoff; no confirmation-token, commit-receipt, or business-version subsystem is built now. A future writer must first establish exact user confirmation, permissions, new-draft/version semantics, conflict and retry handling, and the existing system's review/publication workflow. Availability of those APIs does not block the current read-only phase.

<a id="dependencies"></a>
## Dependencies and status

The scope is settled; remaining prerequisites are source access and data interpretation evidence, not new EMR features.

| Dependency | Required evidence |
| --- | --- |
| Read-only target and access | Exact development database/schema, connection owner, permitted hospital/department/history scope, approved model route, and bounded read settings; credentials remain server-side. |
| Physical mappings | Verify the plan's source-derived table/column/join inventory against the target schema, including nullable states, hospital filters, optional herbal tables, and document-text coverage. |
| Metrics and references | Confirm department/time/diagnosis criteria and source-state definitions; identify approved guideline/institutional material and a clinical reviewer for proposal quality. |
| Acceptance | Identify representative pathway/new-reference tasks, synthetic fixtures, a permitted development sample, and a user who can state expected/actual/pass-fail outcomes. |

Read-only development directory and schema checks verified 287 columns across 19 source tables, without modifying the source. Bounded provider/HTTP-client reads and local live-entry definition/history queries pass; the live model produced and revised a management-review reference. Provider reports retain counts and coverage rather than patient identifiers or body text. The [implementation plan](clinical-pathway-assistant-v1-implementation.md) contains the source inventory and exact verification scope. New clinical-pathway proposal generation, model-invoked `case_read`, clinical quality, and independent user acceptance remain unverified.

<a id="dev-note"></a>
## Dev Note

The [pathway preset](../../deploy/hosted-workspaces/clinical-pathway.preset.yml) analyzes provided material by default; explicit reader composition adds the three tools. Existing [insurance-review requirements](clinical-result-viewer-v1.md) keep their own patient scope and workflow. The user selected the test department and the last year, then explicitly approved reusing the development account with fixed SQL and enforced read-only transactions. Local deployment and the live model demonstration use that approved scope and the existing model route. No source writes or role-grant changes occurred; user acceptance remains pending.
