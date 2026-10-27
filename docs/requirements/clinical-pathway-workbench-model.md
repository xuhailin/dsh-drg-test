# Clinical pathway workbench: shared data and operations

English | [中文](clinical-pathway-workbench-model.zh.md)

Status: revised on 2026-10-27 for confirmed EMR data authority and complete editing ownership. This document sets P1–P5 shared requirements; EMR-extracted definitions own clinical fields/enums without a separate DSH clinical schema. P1 extracts the versioned pure-data definition in EMR and consumes a digest-checked mirror in DSH; actual EMR component integration remains P2.

## Summary

DSH lightweight previews, AI changes/acceptance, EMR complete manual editing, and reports must reference one revision. This document centralizes shared requirements and completeness checks. Clinical field groups below specify coverage rather than alternative names/enums/storage. Both sides reference or generate versioned definitions from one EMR source; packaging/distribution remains implementation design.

## Table of Contents

- [EMR data authority and frontend ownership](#ownership)
- [Tasks, identities, and basic definitions](#identity)
- [Clinical structures](#clinical)
- [Operations, evidence, and artifacts](#operations)
- [EMR compatibility constraints](#compatibility)
- [Dev Note](#dev-note)

<a id="ownership"></a>
## EMR data authority and frontend ownership

M-00 records confirmed ownership: EMR owns clinical pathway shared definitions and complete business components; DSH owns analysis, AI proposals, reference tasks, and lightweight previews. DSH has no clinical forms or duplicate complete editor. Management pages/modals/drawers can host one EMR component without a separate preview application.

Shared content is a serializable pathway definition extracted from EMR clinical fields/enums covering M-03–08. API DTOs, Angular instances, and view state are distinct. Shared definitions exclude patient execution, review workflow, selection, transient inventory, and HTTP dependencies. Necessary structure validation accompanies version descriptions; consumers cannot hand-maintain separate fields or defer mapping until handoff.

Shared definitions must represent unsaved references, unknowns, incompletely read sections, and clinical information lost by existing EMR conversions. Where existing models cannot express these, extend the EMR-owned shared definition and its component consumer rather than adding DSH-only clinical fields. Runtime hydration may resolve identities/project views without reinterpreting clinical meaning, dropping values, or masking unknowns with defaults.

Store clinical content, original read-only sources, and AI metadata separately. Metadata contains task/reference revisions, local identity associations, sources, coverage, questions, proposals, and locks without duplicate clinical content. Displays, exchanges, and reports identify the shared version. Unsupported versions reject consumption/commits while preserving drafts, without silent downgrade or field deletion.

<a id="identity"></a>
## Tasks, identities, and basic definitions

A reference task supplies the working context, a draft holds the editable clinical definition, and historical observations remain separate evidence. None overwrites another.

### M-01 Task and scope

Each task has a stable local identity, new/revision intent, target department/diagnoses, exact analysis scope, and current draft. Scope retains source system, hospital, departments, department basis, diagnosis coding system/type/criteria, time field, timezone-qualified `[from,to)`, authorization reference, and read time. Resolve the latest year into fixed endpoints. A scope change creates a new analysis context without relabeling old statistics. Draft applicability grants no department data access.

A new draft has no hospital definition identity. A revision binds the exact source definition, series, business version, and state at reading, not just a name. Keep the baseline immutable. If the source changes, show differences and staleness; the clinician may rebuild the baseline or start another task. Never silently replace the baseline or edits. Cross-task evidence requires an explicit reference showing its original scope.

### M-02 Identity, dictionaries, and revisions

Tasks, drafts, phases, items, containers, prescription ingredients, and branch links each have stable unique local IDs. Display order, names, dates, and array positions are not identities. Local identities/unsaved references follow EMR shared definitions and associated identity rules, remaining stable across consumers. Do not place UUIDs, negative values, or invented official IDs in existing numeric business-ID fields to accommodate old components. Store source system/hospital, source definition/node/item identities, dictionary internal IDs, business codes, and names separately. Never infer a missing identity from another. Copies receive new local IDs; source identities remain copy origins rather than hospital identities of the new objects.

Dictionary entries retain source, read time/available version, and resolution status: matched, unmatched, ambiguous, or unavailable. A pathway item table is not a complete medication catalog. A typed name may remain a reference placeholder but must not invent codes/internal IDs. Distinguish same-name candidates with different specifications or units.

A draft retains a format identifier/version, local draft ID, increasing reference revision, immutable baseline reference, and current content. Reference revisions `r1/r2` are not hospital `versionNo`. The model cannot assign official definition IDs, pathwayCode, or business versions. A format version describes local interpretation, not EMR import support.

### M-03 Header and departments

Retain pathway name, description, owner department, applicable departments, stay lower/upper limits, and reference cost lower/upper limits with currency/source basis. Mark absent currency/values unknown. Costs are reference ranges, not forecasts or guarantees. Separate owner and applicable departments, preserving codes/names/sources. A lower limit cannot exceed its upper limit; unknown does not default to zero.

<a id="clinical"></a>
## Clinical structures

These business contents must be representable, inspectable, and preserved. P1 must already carry existing complex content without loss; P2 adds complete transformations. An unavailable editor never justifies silently dropping fields.

### M-04 Diagnoses and admission

Diagnoses retain codes/names, coding systems, source identities, order, and any grouping declared by the source; absent logic does not imply AND/OR. Admission conditions retain inclusion/exclusion type, basis category code/name, condition body, required-assessment flag, and order. Keep the body separate from the display prefix `[basisKindName]`; display composition does not alter it. Uninterpretable source entries retain original values and questions.

### M-05 Phases and dates

Phases retain name, clinical properties, date basis (admission/surgery/discharge day), lower/upper day bounds, predecessor reference, display order, and source node identity. Intervals may span days. Basis and interval jointly interpret a day; surgery offsets are not admission days. Unknown source enums/intervals remain unresolved. Do not automatically reorder, merge overlapping intervals, or split all phases into daily cards.

Adding/copying/deleting/splitting/adjusting phases preserves item ownership, containers, ingredients, predecessors, branches, locks, and evidence references. Internal copy references target new copies; external references explicitly retain or redirect their targets without dangling links. Reject new predecessor cycles, self-references, or inverted intervals. Existing anomalies may remain flagged without automatic clinical repair. Before deleting referenced objects, preview affected items and choose an explicit resolution. Cancellation leaves the draft unchanged.

If “change X to Y on day 3” hits an admission-day 3–4 phase, first show the phase, matched items/group relationships, and two scopes: whole-phase change affecting days 3 and 4, or day 3 only requiring a split. Resolve unknown date basis/targets first. The day-only option must preview resulting intervals, copied items, predecessors, and branch references before confirmation. Without confirmation, apply neither scope.

### M-06 Single orders, clinical work, and nursing

Single orders distinguish medication, laboratory, examination, and surgery applications. Preserve dictionary identity and business code/name, class/subclass, specification, dose, dose unit code/name, base/minimum/package units and conversion material, route code/name, long/temporary term, frequency code/name, days, instructions, required flag, variable-dose flag, self-supplied flag, repeatability, execution department code/name, and application/template links. Mark inapplicable fields explicitly; missing source values remain unknown. A zero dose is a value, neither missing nor evidence of clinical validity.

Clinical/documentation and nursing work each retain concrete dictionary/template identities, business codes/names, required rules, order, and source rather than free-text titles alone. Historical identity ambiguity retains original fields and possible interpretations, marked unresolved; name matching does not settle it.

Replacing a medication rechecks target specification, dose, unit, route, frequency, and term applicability. Old values may appear for comparison but cannot automatically become confirmed values for the replacement. Unsupported parameters remain unresolved, and original content supports undo. Laboratory/examination/surgery replacements likewise recheck related applications/templates instead of changing a label alone.

### M-07 Groups, bundles, and selection

This document uses single/group/bundle as clinical terms; exchange uses actual EMR shared fields/enums without DSH string tags. Groups contain singles only; bundles contain singles/groups. Reject nested groups, bundles inside groups, and bundles inside bundles. Do not flatten containers into unrelated items. Containers retain local identity, order, name/source, required/repeatable flags, and explicit selection rules. Unknown rules stay unknown; repeatability, single/multiple selection, and requiredness are distinct.

Group maintenance checks the verified EMR rules: medication singles excluding whole prescriptions, eligible routes, and the same execution department. Type validity alone does not establish clinical grouping validity. Preserve shared group fields, child-specific fields, and selection rules separately. Verified shared fields include route, frequency, execution department, days, requiredness, and repeatability; frequency also affects term. Shared-field edits preview every affected member, while individual fields such as dose affect their target only. Existing EMR single/multiple-mode changes clear child requiredness, and requiredness changes inside single-select bundles affect other candidates. The workbench must show values to clear, retain, or transfer and apply them only after confirmation, without silently copying destructive clearing. Ungrouping/moving items likewise previews rule and field changes. Unverified rules or unavailable catalogs permit a gap-bearing reference draft, never a passed compatibility check.

### M-08 Herbal prescriptions and linked pathways

A whole prescription consists of a header and ordered ingredients, not one medication name. The header retains name, term, execution department, prescription/decoction counts, route and auxiliary route, frequency/dosing rate, decoction method, treatment principle, note, special route, decoction/prescription/outpatient flags, herb type, decoction volume, and times. Each ingredient retains local/source identities, medication internal ID/code/name, classification, specification, quantity/dose, dose/base/dispensing/minimum/package units and codes, conversions, route/processing material, order, and note.

Current verified EMR support treats whole prescriptions as temporary orders. Other term requests remain compatibility questions without silent conversion. A linked pathway references another exact source pathway from a phase, retaining target definition/version/state, association properties, source, and read coverage. It is not a nested task tree. Unreadable targets or cyclic links retain references/limits, prevent infinite expansion, and never invent target contents.

<a id="operations"></a>
## Operations, evidence, and artifacts

EMR manual edits and DSH AI proposals share clinical semantics/reference commits. DSH clicks select, accept, defer, lock, and undo; EMR owns clinical forms. Accepted content has one saved authority.

### M-09 Changes, locks, and undo

Each change retains target local ID/field, base revision, before/after values, impact scope, rationale, evidence, dependencies, questions, and origin. EMR reference form commits create undoable revisions. Deletion, replacement, and cross-day/container/reference transformations require preview and confirmation. AI output always becomes a proposal before changing the draft. Dependent changes apply as one indivisible transaction; independent changes can be accepted individually or in one batch.

Proposal states distinguish pending, needs confirmation, deferred, accepted, undone, stale, and failed. A change cannot be accepted while its scope or dependencies remain unresolved. Acceptance rechecks current revision, object existence, access, and locks. Retrying the same apply request does not apply twice. An atomic save failure produces no partial revision, leaving the previous confirmed draft available.

If list entries A and B both use r1, accepting A as r2 does not automatically stale B. Recheck B against the current revision for target original values, dependencies, scope interpretation, references, and locks. If all remain unaffected, update its preview basis and record the checks so the clinician can accept B without regenerating the list. Any affected condition makes B stale and requires another preview/confirmation, preserving independent manual edits. Other deferred entries remain deferred.

Locks can target objects or fields. Structural operations touching locked descendants also touch locks; the model cannot unlock. Only explicit user unlocking allows a new preview. Undo creates an inspectable compensating revision and retains the original record. If later changes depend on the reverted content, list affected changes and require dependent undo or a revised proposal, preserving unrelated edits.

### M-10 Evidence, coverage, and clinical questions

Evidence references retain category (historical observation/calculation/guideline or institutional standard/human opinion/model inference), source identity, original scope, read/material time, version/passage, and coverage. Distinguish complete, partial, unread, unavailable, inapplicable, and unknown. Unmatched dictionaries differ from incomplete reading. Each question locates an object/field, states missing information, resolution, and blocked operations. Present questions together by blocking impact rather than scattering unlocatable prompts.

Historical observations and candidates are separate from draft definitions. Draft edits cannot alter statistics, denominators, or source times. Incorporation requires a separate proposal retaining the observation identity. Order existence, system completion flags, and observed frequency do not establish actual execution, outcomes, or cost benefit. User material retains its source category and cannot be promoted to a guideline by the model.

### M-11 Persistence, inspection, and delivery

Private Sessions retain enough records to restore the exact revision, baseline, changes, locks, and evidence references. Model-visible structure/evidence must be reconstructable from recorded content, not unlogged browser state. Refresh/model failure preserves saved manual edits. Expired access blocks new source reads and evidence access requiring renewed source access. Saved material follows existing private Session/file policy. This group does not promise retrospective hiding of old logs or recall of exported files; those capabilities require separate access and retention requirements.

Inspection, DSH lightweight previews, the EMR component, and reports read the same revision and EMR shared-definition version. Read-only JSON inspection does not create a second editable source. Artifacts bind at least task/draft/format version/reference revision, source baseline, analysis scope, individual source times, differences, evidence references, and gaps. If edits arrive during report generation, output the pinned older revision labeled noncurrent or regenerate. Never combine revisions.

### M-13 Cross-host reference editing and commits

The DSH private reference task is the sole authority for saved drafts. EMR holds only a temporary working copy bound to task/local draft/shared version/base revision. Hosts supply loading/commit capabilities. Initialization/tab changes/closing must not reload hospital definitions, mutate supplied snapshots, create business records, or save implicitly. Existing maintenance hosts retain hospital workflows without sharing hospital-write capabilities with reference mode.

AI selections target objects in committed reference revisions only. Unsaved EMR additions, changed targets, or affected dependencies cannot masquerade as saved selections. Commit the reference or explicitly discard related edits before AI operations on that target, or cancel/continue editing. Unaffected saved objects remain selectable with an explicit base and dependency rechecks, without representing old values as the latest local values.

Before host-interceptable close/task changes, unsaved edits require a visible state and choices to continue, explicitly discard, or commit the reference before leaving. Commits use P1 only; failure/unknown outcomes remain actionable without hospital saving. Cancelling exit preserves the working copy; discarding leaves saved content unchanged. Forced logout/reload/process loss does not promise unsaved recovery, and invalidated bindings cannot expose copies to a new account/task.

Manual commits carry base/candidate differences, commit identity, and target context for P1 validation/atomic application, never whole-copy overwrite of the latest revision. Success returns the exact revision before consumers refresh. Failure preserves prior saved content/local edits. Unknown outcomes require status checks with the same commit identity rather than hospital saving. Changes independent of AI edits may commit after M-09 rechecks; affected content requires renewed preview/confirmation.

Bindings verify actual caller, allowed source/window or connection identity, login relationship, and task access. EMR login is not DSH authorization, and hospital/department fields cannot grant reads. Account/task changes or reload invalidate old bindings/in-flight results. Reconnect reads the current revision and checks conflicts before resuming unsaved work. Without EMR, DSH retains independent AI/reference capabilities while complete manual editing is unavailable, without a fallback duplicate editor.

<a id="compatibility"></a>
## EMR compatibility constraints

M-12 records rules a future adapter must verify. This round preserves representability and inspectability without implementing hospital-write adapters or promising hospital-write readiness. EMR reference consumption is current P1/P2 acceptance, not a deferred write-integration question.

| M-12 Check | Known constraint and future owner |
| --- | --- |
| Multi-resource saving | Header, departments, diagnoses, admission, phases, branches, and items are handled separately. No whole-pathway import or unified new-version draft DTO was found. Future writes must verify APIs, transaction/partial-failure handling, official numbering, permissions, and review workflow. |
| Dictionary/template identity | Clinical-documentation/nursing creation uses itemCode/templateCode, while edits historically may place dictionary id in code. Preserve the distinction for future API verification. |
| Flags and dose | Clinical singleUse is the inverse of wire isMultipleChoice. Wire onceDose is a string and zero must survive. Separate codes/names; a unit label is not its code. |
| Admission/prescriptions | Do not duplicate the basis display prefix in condition bodies. Preserve prescription headers/ingredients and known temporary-order compatibility limits. |
| Structures/unknowns | Groups contain singles only; bundles contain singles/groups only. Do not claim write readiness before future parameter mappings, selection rules, and unknowns are verified. |

Source evidence comes from `emr-app` files `clinical-pathway.serialize.ts`, `clinical-pathway.repository.ts`, `treatment.ts`, `herbal-recipe.ts`, and maintenance templates. The [V1 implementation record](clinical-pathway-assistant-v1-implementation.md) owns read mappings. These files establish reference structures/frontend behavior, not equivalent saving support in a hospital deployment.

<a id="dev-note"></a>
## Dev Note

P1 must establish concrete shared definitions under EMR ownership. Distribution, transport, and persistence remain implementation design without generic state/microfrontend platforms or agent-loop changes.
