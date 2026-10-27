# P4: AI creation and controlled changes

English | [中文](clinical-pathway-workbench-p4-assistance.zh.md)

Status: revised on 2026-10-27 for DSH AI/EMR complete manual editing, with details awaiting review. P4-A requires P1/P3-A when used. P4-B first accepts corresponding P2-B clinical semantics, without requiring an online EMR window at runtime. See the [overview](clinical-pathway-workbench-roadmap.md) and [shared model](clinical-pathway-workbench-model.md).

## Summary

Clinicians can create a structured new reference by department/diagnosis or revise an exact version, select an item and ask how to change it, request multiple changes in one sentence, or turn department discussions into a change list. The system locates targets and presents impacts/evidence before individual/batch acceptance, deferral, or undo, preserving manual edits and locks.

## Table of Contents

- [Clinical task and scope](#scope)
- [Behavior and operation ownership](#requirements)
- [Data prerequisites and dependencies](#dependencies)
- [Acceptance scenarios](#acceptance)
- [Stages and deferrals](#stages)
- [Dev Note](#dev-note)

<a id="scope"></a>
## Clinical task and scope

Inputs are the target cohort, draft/exact source version, available clinical material, and historical observations. Outputs are structured new-proposal candidates or actionable local change proposals for clinician review, with explicit gaps when clinical parameters lack support.

Includes language-based targeting, structured creation, multiple changes/dependencies, evidence inspection, impact previews, accept/defer/undo, and discussion lists. Excludes autonomous treatment approval, filling essential clinical judgments, hidden unlocking/overwriting, hospital saving, review/publication, broad online patient-data collection, and independent write DTO generation.

<a id="requirements"></a>
## Behavior and operation ownership

P4 owns DSH intent interpretation/proposals/acceptance. P1 commits/persists EMR shared clinical data; P2 owns complete manual components/complex semantics acceptance, P3 candidates, and P5 exact revisions. DSH adds no clinical forms; impact-scope confirmation and acceptance controls remain in DSH.

| ID | Required observable behavior | Model |
| --- | --- | --- |
| P4-01 | New tasks produce structured candidates containing header, diagnoses/admission, phases, items, and applicable links, explicitly retaining unknowns. Revisions propose relevant differences while preserving unchanged content/exact baseline. Prose cannot replace structure. | M-01–08,10 |
| P4-02 | “Here” binds a recorded selection from DSH light previews or an authorized EMR host, including identity/field/shared version/reference revision. Targets are visible at send time. M-13 validates EMR selections; task/account changes invalidate old selections. Unsaved additions/changed targets/dependencies require a reference commit or explicit related-edit discard, with continued editing available. A working copy cannot be presented as saved content to AI. Deleted/changed selections or duplicate-name matches require target confirmation, not name-based guessing. | M-02,09,11 |
| P4-03 | Multiple requests become located entries showing before/after, date/phase/container effects, rationale, sources, and unknown parameters. Independent entries support separate acceptance/deferral; dependent entries show indivisible transactions/order. | M-05–10 |
| P4-04 | Preview both new proposals and modifications. Acceptance rechecks scope, revision, locks, and structural validity. Acceptance/batch/retry/undo use common transaction semantics. Undo preserves unrelated changes. | M-09 |
| P4-05 | Day 3 requests against multi-day phases use M-05/P2-B accepted semantics for scope choice/reference previews. Without complex transformations, P4-A locates the request and explains deferral without an apparently acceptable fake split. | M-05,09 |
| P4-06 | Medication replacements individually recheck target specifications/dose/units/route and related parameters. Unsupported values remain unresolved. Distinguish unmatched dictionaries, unknown parameters, and incomplete sources rather than treating name replacement as a complete proposal. | M-02,06,10 |
| P4-07 | Important clinical requirements/historical conclusions expose actual evidence/passages and applicability. Distinguish observations, calculations, guidelines/standards, human opinions, and inference. Turning historical candidates into draft content requires separate acceptance without automatic requiredness/standard status. | M-10 |
| P4-08 | Convert department discussions into changes with source passages, distinguishing consensus, suggestions, conflicts, and questions. Speaker opinions are not guidelines. Contradictory changes retain conflicts for clinician choice without automatic merging. | M-09–10 |
| P4-09 | Group questions into a small set of located items identifying needed decisions and blocked scope. Independent changes remain actionable. Do not reask settled intent/access or regenerate an entire pathway for one missing parameter. | M-09–10 |
| P4-10 | Model failure, cancellation, or invalid structure preserves existing/manual content without application. Inputs, selections, evidence, and results remain privately recoverable. Regeneration uses the current revision; stale proposals do not replay automatically. Unaffected remaining entries may continue individually after M-09 rechecks and preview-basis updates. | M-09–11 |

<a id="dependencies"></a>
## Data prerequisites and dependencies

P1 supplies EMR shared definitions, persistence, and commits. P4-A can first accept single-item proposals; P2 owns complete manual clinical editing. History-based creation consumes P3-A scope/candidates. Without history, clinician-provided goals/material may support drafting while explicitly lacking live samples. P4-B first accepts relevant P2-B semantics, then uses shared rules through P1 commits. DSH AI operations cannot call browser-only EMR classes or require an active editor. Structured model output must match the EMR shared version, without a DSH schema converted only at handoff.

Clinical references must be accessible/applicable; EMR's empty guideline page is not a source. The model cannot seek credentials, expand department reads, or send patient content to public search. Missing references permit a structurally complete draft with unresolved clinical values, never invented treatments/doses/thresholds. Until Q2 is resolved, treatment-proposal quality cannot pass.

<a id="acceptance"></a>
## Acceptance scenarios

Check drafts, change lists, sources, and restoration records together; conversational output alone cannot establish completion.

| Scenario | Observable pass condition |
| --- | --- |
| Success: new and exact-version revision | Run both tasks in the same authorized scope. New output is a structured candidate; revision changes requested content only without invented baselines/hospital IDs. Unsupported parameters remain questions. |
| Success: here plus multiple changes | Select one of two same-name items and request a frequency change plus required nursing work. Targets are explicit; accepting one and deferring the other changes only accepted content. |
| Edge: sequential acceptance within one list | A/B/C use r1. After A, recheck unaffected B, update its preview basis, and accept it; C stays deferred and independent manual edits survive. Changed targets/dependencies stale only B and require a new preview. |
| Success: batches and dependencies | A batch of independent changes creates one consistent revision. Dependent split-plus-edit changes cannot accept the second half alone; retries do not duplicate application. |
| Edge: cross-day replacement | A day 3–4 phase does not silently select scope. A confirmed day 3-only request uses P2; replacement parameters are rechecked. P4-A explicitly lacks this transformation. |
| Edge: EMR selection/interleaved edits | An EMR selection reaches the current task accurately, and DSH shows that object before proposals. Subsequent EMR commits stale only affected AI entries; old bindings/selections cannot enter a new task. |
| Edge: unsaved here | Unsaved EMR additions/changed target fields produce no acceptable AI proposal against nonexistent objects/old values. Commit/discard/continue choices are explicit; unaffected saved items remain actionable. |
| Edge: EMR unavailable | After EMR closes/disconnects, DSH can still propose/accept/restore supported structures. Complete manual editing is explicitly unavailable without fallback clinical forms. |
| Failure: locks and intervening edits | The model cannot change locked content. Intervening manual edits affecting targets, dependencies, or scope stale the affected proposal rather than being overwritten; independent entries follow M-09 rechecks; refresh preserves committed manual edits/locks; unsaved EMR copies are not represented as saved content. |
| Edge: discussion conflicts/observations | Opposing comments retain conflict/source passages. Frequent historical medication remains a candidate without adding required care/thresholds before clinician acceptance. |
| Failure: model output/missing evidence | Invalid nesting, fabricated codes, and unread material cannot apply as validated content. Failures preserve the draft, locate gaps, and allow independent supported entries. |
| Edge: undo after new edits | Undo preserves unrelated edits. Dependencies show affected scope and require a compensating choice without hidden whole-version rollback. |

<a id="stages"></a>
## Stages and deferrals

P4-A delivers new/revision tasks for simple structures, selection targeting, multiple proposals, evidence/questions, individual/batch/defer/undo, and basic discussion lists for M2. It may read complex content and explain coverage, but cannot propose applicable complex transformations.

After corresponding P2-B semantics acceptance, P4-B completes controlled generation/revision of phase splits/copies, containers, prescriptions, links, complex dependencies, and discussion conflicts. Clinical optimization, rule-free historical trials, and autonomous approval are excluded. Model/provider choice, structured-output mechanisms, and retry counts remain implementation design, not substitutes for acceptance.

<a id="dev-note"></a>
## Dev Note

Clinical-quality acceptance requires Q2 references/a clinical owner. Shared versions, EMR host bindings, and AI execution without a running editor require separate verification; independent requirements review replaces none of these.
