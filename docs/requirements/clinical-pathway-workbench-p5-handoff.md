# P5: Discussion reports and structured reference handoff

English | [中文](clinical-pathway-workbench-p5-handoff.zh.md)

Status: revised on 2026-10-27 for EMR shared definitions/component consumption, with details awaiting review. P1 is required; P5-A uses P2-A for actual component consumption, retained complex payloads do not require the complete P2-B editor, and P3/P4 apply when referenced. See the [phased overview](clinical-pathway-workbench-roadmap.md) and the [shared data requirements](clinical-pathway-workbench-model.md).

## Summary

Pathway owners can generate a department discussion report and inspectable structured handoff from an exact reference revision. Reports retain scope, sources, changes, rationale, questions, and coverage; structured artifacts preserve clinical relationships so recipients can verify that both describe one revision. Payloads must already be consumable by the same-version EMR component. This current acceptance is separate from future hospital import/saving.

## Table of Contents

- [Owner task and scope](#scope)
- [Behavior and artifact ownership](#requirements)
- [Data prerequisites and dependencies](#dependencies)
- [Acceptance scenarios](#acceptance)
- [Stages and future integration](#stages)
- [Dev Note](#dev-note)

<a id="scope"></a>
## Owner task and scope

Start from a saved revision produced manually or through accepted AI proposals, possibly with explicit clinical questions. The outcome is a private reference handoff with verification results for discussion/follow-up; AI is optional.

The package includes a discussion report, structured definition, baseline-relative differences, evidence index, and gap list bound to one revision. Reports lead with decisions needed by the department, then phases/items, without requiring raw case text. Excludes EMR import packages, business drafts, official codes/versions, patient orders, automatic review submission, external messaging, and site publication.

<a id="requirements"></a>
## Behavior and artifact ownership

P5 owns revision-pinned reports/delivery records without writing draft content. Findings return to P2 EMR manual edits or P4 DSH proposals. P5 neither repairs clinical content nor recalculates independent historical statistics.

| ID | Required observable behavior | Model |
| --- | --- | --- |
| P5-01 | Select/display a saved revision, task, new/revision intent, baseline, and cohort before generation. New edits during generation either retain the pinned old revision labeled noncurrent or trigger regeneration, never mixed content. | M-01–02,11 |
| P5-02 | Reports include purpose/reference labeling, applicable population/exclusions, data scope and source times, key structures, changes/rationale, important references, distinction between observations/clinical suggestions, questions, and coverage. Phase/item details locate structured content. | M-03–11 |
| P5-03 | Deliver same-version EMR clinical payloads and associated metadata, preserving clinical fields/identities/containers/ingredients/predecessors/links/unknowns/sources, with shared version/reference revision/format identifier. Do not create DSH-specific clinical JSON or defer field mapping to reporting. Do not reconstruct a second structure from report prose. | M-02,05–08,11 |
| P5-04 | Differences distinguish add/edit/delete and phase/container relationships, listing accepted operations. Deferred/unconfirmed proposals are not accepted changes. Undone operations remain in history but not current content; new drafts explicitly lack hospital baselines. | M-01,09–11 |
| P5-05 | Report structural consistency, source/dictionary coverage, clinical questions, and future hospital-write questions separately without one write-ready indicator. Locate unknown codes, unverified parameters, incomplete sources, and type ambiguity. | M-02,09–12 |
| P5-06 | Newly generated structured artifacts check unique local IDs, resolvable references, legal containers, date ranges, and matching revisions. Unresolved external targets retain references/gaps. Local structural failure may yield a clearly failed diagnostic report, never a passed package. | M-05–09,11 |
| P5-07 | Save in the user's private Session/requested private reference-file destination with files, revision, generation time, and success/failure. Failure preserves prior valid delivery. No external-message or hospital-submission receipt is implied. | M-11 |
| P5-08 | Evidence indexes contain only necessary references/passages, excluding patient identifiers/full charts by default and noting inaccessible evidence. Generation/export/restricted evidence viewing retain private access and data minimization without relaxed export permissions. | M-10–11 |

<a id="dependencies"></a>
## Data prerequisites and dependencies

The minimum data dependency is a P1 saved draft with baseline/scope/EMR shared version. P5-A acceptance follows P2-A component consumption; JSON parsing alone cannot establish EMR usability. P3 observations retain denominators/times/coverage; P4 content uses accepted results for the chosen revision only. Untransformed existing payloads need shared validation and actual P2-A consumption without waiting for the full manual editor. Actual complex changes additionally require their accepted operation semantics, not every P2-B screen. Manual drafts without history/AI remain deliverable with corresponding gaps/source labels.

Report shared reading/validation, actual EMR component consumption, clinical quality, and hospital submission adaptation separately. The first two are current requirements, not deferred compatibility. The latter two retain separate evidence/permission prerequisites. Preserve source anomalies in diagnostic material instead of deleting them to pass checks. Update results only after actual resolution. Implement failure/regeneration paths without prerequisite import/receipt/signature services.

<a id="acceptance"></a>
## Acceptance scenarios

Owners must locate the same objects from report to structure, while technical verification checks fields/references. Both are required; clinical treatment quality remains separate.

| Scenario | Observable pass condition |
| --- | --- |
| Success: new/revision handoff | Deliver report/structure/differences/gaps for each with consistent identities. New drafts lack hospital baselines, revisions reference exact definitions, and neither claims business saving. |
| Success: direct same-version EMR preview | Load delivered payloads/metadata in the P2-A reference host. Unsaved references display the same revision without hospital reloads, field renaming, default clinical values, or hospital-save requests. |
| Failure: unsupported shared version | An unsupported component version rejects consumption without dropped fields or a success display. Existing reports/drafts retain revisions; regeneration selects a mutually supported version. |
| Edge: incomplete manual editor | Before P2-B completion, simple edits to a complex draft still deliver every retained bundle/prescription/predecessor/link in P5-A and verify it in P2-A, without trimming/refusal merely because content is complex. |
| Success: complex preservation | Preserve bundle→group→single, three-ingredient prescriptions, multi-day phases, predecessors, and links. Reports locate the same IDs without flattening or lost codes/units. |
| Edge: intervening revision | Saving r3 while r2 generates leaves all files consistently bound to r2 labeled noncurrent, or regenerates a consistent r3, without mixing. |
| Edge: deferred/undone changes | Accepted/deferred/undone entries have distinct report states. Current structure contains effective changes only, with inspectable undo history. |
| Failure: broken local structure | Duplicate IDs, dangling predecessors, invalid nesting, or mismatched revisions fail validation with locations/correction paths, without a successful package. |
| Edge: clinical/dictionary questions | Locate missing dose, unmatched dictionaries, and incomplete sources separately. A clearly limited reference handoff is allowed without write-ready or clinical-pass claims. |
| Failure: save/evidence access | Export failures show status without damaging prior delivery. Report generation does not expose restricted patient evidence or automatically send files. |

<a id="stages"></a>
## Stages and future integration

P5-A delivers a basic report, P2-A-consumable same-version payload, metadata, differences, and gaps in M2, preserving all identity/source/unknown rules. P5-A already preserves existing complex structures. P5-B adds acceptance for actual complex transformations, relationship differences, and diagnostic reports, requiring relevant operation semantics rather than the entire manual UI for M3. PDF/Word layout, template management, signatures, and bulk export are deferred.

Future EMR writes separately confirm actual APIs/multi-resource submission, permissions/business versions, dictionary/template ambiguity, locking/conflicts, partial failures/retries, approval/publication, and acceptance. P5 neither implements these nor requires them for reference handoff. Preserve M-12 questions without claiming an implemented adapter.

<a id="dev-note"></a>
## Dev Note

Local saving grants no external delivery/hospital writes. Artifact formats cannot bypass this read-only reference scope; successful reference consumption grants no hospital-save authority.
