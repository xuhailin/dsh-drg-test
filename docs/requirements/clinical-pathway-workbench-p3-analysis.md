# P3: Department history and observation candidates

English | [中文](clinical-pathway-workbench-p3-analysis.zh.md)

Status: proposed requirements awaiting user review. Reuses the three deployed tools without rebuilding data access infrastructure. Scope/identities follow the [overview](clinical-pathway-workbench-roadmap.md) and [shared model](clinical-pathway-workbench-model.md).

## Summary

Clinicians select an authorized department, period, diagnoses, and pathway version, inspect history with explicit denominators, reuse a statistic's cohort, and place traceable observations in a candidate area. Draft edits do not change history, and candidates become neither clinical standards nor draft content automatically.

## Table of Contents

- [Clinical task and scope](#scope)
- [Behavior and data ownership](#requirements)
- [Data prerequisites and dependencies](#dependencies)
- [Acceptance scenarios](#acceptance)
- [Stages and deferrals](#stages)
- [Dev Note](#dev-note)

<a id="scope"></a>
## Clinical task and scope

Starting from P1 task scope, the outcome is a verifiable cohort analysis and observation candidates. Clinicians may use history for department discussions without proposing treatment; P3 therefore depends on neither P2 EMR components/complete manual editing nor P4 AI operations.

Includes pathway/diagnosis filters, distinct encounters/execution counts, source states/retained reasons, denominators/coverage, bounded relevant-case evidence, candidates, and cohort reuse. Excludes self-service SQL, a complete chart warehouse, true execution-completion rates, unsupported outcome/cost-benefit comparisons, realtime monitoring, prediction, and automatic derivation of standards from history.

<a id="requirements"></a>
## Behavior and data ownership

P3 owns analysis contexts, statistical observations, and candidates. Source evidence stays read-only. P1 references their identities; P4 converts selected candidates into proposed changes.

| ID | Required observable behavior | Model |
| --- | --- | --- |
| P3-01 | Show both authorized scope and actual filters, fixing endpoints/timezone, department basis, and applicable diagnosis type/main/suspected criteria. Changing scope creates a new context; old results retain original labels. | M-01,10 |
| P3-02 | View pathway/diagnosis/exact-version statistics with distinct encounter/execution counts. Interpret completion/withdrawal/nonpathway states from source enums. Define non-enrolled comparison cohorts separately by admission/discharge windows without an enrollment-time denominator. | M-01,10; V1 statistics semantics |
| P3-03 | Clicking a statistic shows/reuses full cohort criteria plus that statistic's predicate for case evidence or P4 new tasks. If only aggregates are available, reuse criteria while explaining that immutable membership was not retained. | M-01,10 |
| P3-04 | Read selected case categories/passages only through case_read, showing definition version, source time, coverage, paging, and read progress. Incomplete/unreadable/unsupported content is not absence; completion flags do not establish performed care. | M-10 |
| P3-05 | Explicitly add observations to candidates with sources, numerator/denominator, cohort, time, coverage, observation, and clinician notes. Allow removal/deferral. Deduplication preserves references without merging rates across scopes. | M-02,10 |
| P3-06 | Expose calculation bases. A zero denominator is inapplicable rather than 0% completion; absent sources mean unknown rather than zero. Retained reasons are records, not complete historical variation counts. | M-10 |
| P3-07 | EMR reference edits, candidate removal, and DSH AI proposals do not alter statistics. Refresh creates a new observation showing read-time/coverage differences rather than a global snapshot. Query failures retain old results clearly labeled not refreshed. | M-01,10–11 |
| P3-08 | Preserve categories for frequent historical items, low-frequency gaps, and clinician opinions. P4 receives discussion input without automatic promotion to required care, doses, admission thresholds, or guidelines. | M-06,10 |

<a id="dependencies"></a>
## Data prerequisites and dependencies

Depends on P1 scope/evidence identities and private restoration. Existing tool permissions, fixed SQL, bounded paging, and coverage remain. Metrics requiring unsupported lab/exam/surgery/administration execution or complete documents become gaps, not a new source-integration project inside this PRD.

Hospital `1001`/test department `99999` may lack disease-specific treatment examples. Empty cohorts differ from failures. Comparisons retain separate filters/denominators; missing execution/completion dates cannot produce mean completion durations. Clinical completion, outcomes, and savings require additional sources/definitions and are not promised.

<a id="acceptance"></a>
## Acceptance scenarios

Acceptance concerns verifiable statistics and traceable references, not the number of charts/cases or length of generated explanation.

| Scenario | Observable pass condition |
| --- | --- |
| Success: reuse statistic cohort | Opening evidence/new reference from an authorized state statistic preserves inspectable hospital, department basis, diagnoses, period, and state criteria without expanded authorization. |
| Edge: multiple diagnoses/executions | An encounter with two diagnoses/multiple executions counts once as an encounter and separately as executions. Retain actual versions; non-enrolled comparison cases remain despite absent executions. |
| Success: observation candidate | Adding a frequent observation exposes source/basis/time/clinical limits without changing the draft; P4 still labels it historical observation. |
| Failure: unreadable/incomplete sources | Missing text, unsupported categories, and first-page-only results show coverage without asserting absent documents or unperformed care. Candidates retain those limits. |
| Edge: empty cohort/partial denominator | A genuinely empty cohort shows zero encounters with inapplicable ratios. Failure shows unavailable. Partially read details cannot substitute page counts for full denominators. |
| Edge: edits and refresh | Draft edits leave statistics unchanged. A refresh produces newly timed observations with visible source changes; old candidates retain their original basis. |
| Failure: unauthorized access/inference | Reject reads for other live departments. System completion, order existence, and retained reasons do not become actual care completion, outcomes, or cumulative variation. |

<a id="stages"></a>
## Stages and deferrals

P3-A delivers basic pathway/diagnosis/source-state statistics, cohort reuse, sources/coverage, and single-observation candidates for M2. P3-B completes multiple-candidate comparison, notes/deferral, and finer case-evidence location using existing supported sources. A comprehensive analytics portal is unnecessary.

Historical sample trial runs remain separate exploration requiring matching rules, necessary data, handling of unknowns, and acceptance cases. They may report rule matches/gaps, not predicted outcomes or cost benefits, and are outside P3-A/B completion.

<a id="dev-note"></a>
## Dev Note

Statistical meanings follow the [V1 association rules](clinical-pathway-assistant-v1-implementation.md#joins), without a second table/field inventory.
