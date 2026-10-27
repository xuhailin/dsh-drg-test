# P2: EMR single-pathway components and complete reference editing

English | [中文](clinical-pathway-workbench-p2-structures.zh.md)

Status: revised on 2026-10-27 for confirmed UI ownership. Depends on P1 and splits into P2-A reference preview and P2-B complete manual editing. See the [overview](clinical-pathway-workbench-roadmap.md) and [shared data requirements](clinical-pathway-workbench-model.md).

## Summary

Clinicians view or fully edit DSH references within EMR through one single-pathway component hosted by a management page, modal, or drawer. It accepts EMR shared data, with loading/commit supplied by its host. Reference edits save to the same DSH revision; hospital maintenance retains its existing workflow.

## Table of Contents

- [Clinical task and scope](#scope)
- [Component separation and editing](#requirements)
- [Cross-day confirmation semantics](#cross-day)
- [Data prerequisites and dependencies](#dependencies)
- [Acceptance and stages](#acceptance)
- [Dev Note](#dev-note)

<a id="scope"></a>
## Clinical task and scope

P2-A independently enables accurate EMR component previews of references not stored in the hospital database. P2-B enables full manual editing of header, departments, diagnoses/admission, phases, items, and relationships, committed as a new revision of the same task. The component works independently of the management list without requiring a separate preview product outside EMR.

Clinical forms/complex editing belong to emr-app. DSH's lightweight table serves inspection, selection, and AI entry. P2 includes necessary host integration and reference/business-mode separation, excluding new hospital drafts/official codes, hospital save/review API changes, patient execution, generic microfrontend infrastructure, automatic scheduling, and unlimited nesting.

<a id="requirements"></a>
## Component separation and editing

Existing ClinicalPathwayComponent has viewMode and review reuse, but constructs clinical datasources, loads by business ID, and contains save/review actions. P2 reuses it while separating these responsibilities; an exported component does not establish external-reference preview support.

| ID | Required observable behavior | Model |
| --- | --- | --- |
| P2-01 | A single-pathway view/editor loads P1 shared data without a management list, cpList filter, or maintenance route. Construction/reference preview must not reload by old hospital ID and overwrite supplied content or reject missing hospital identity. | M-00–02,13 |
| P2-02 | The same component receives data/actions from business or reference hosts. Reference mode exposes reference read/commit only, with no hospital save/delete/copy-create/review/activation operations. Enforce this in callable capabilities/handlers, not just hidden buttons. | M-11–13 |
| P2-03 | Management pages/modals/drawers reuse one component. Display consumes a snapshot without mutating input, applying defaults, or changing baselines on initialization/tab changes/close. Distinguish read-only preview/reference editing and show gaps. Dirty exits/user-initiated task changes follow M-13 continue/discard/reference-commit choices without silent loss. | M-00,09–13 |
| P2-04 | Complete manual editing covers all applicable M-03–08 fields: header/departments, diagnoses/admission, phases, medication/lab/exam/surgery, clinical/nursing work, bundles, prescriptions, and linked pathways, using existing forms/selectors and shared EMR fields. | M-03–08 |
| P2-05 | Phase add/copy/split/adjust/delete previews date basis/ranges, items, predecessors/successors, links, locks, and evidence. Copy references target new local objects; external references are explicit. Failure leaves no partial transformation. | M-02,05,09 |
| P2-06 | Group/bundle creation/editing/ungrouping preserves order/rules. Individual fields such as dose affect their target; shared route, frequency, department, days, requiredness, repeatability, and term linkage all preview. Selection/requiredness changes show values to clear/transfer before consistent application and undo. | M-06–07,09 |
| P2-07 | Edit prescription headers/ingredients fully without flattening. Phases link exact pathways with target versions/coverage. Unmatched parameters and unreadable/unauthorized/cyclic targets retain limits; the current EMR account cannot silently expand reads. | M-01,06–08,10 |
| P2-08 | EMR working copies bind task/shared version/reference revision and the current identity relationship. P1 commits produce one revision reflected in DSH previews/AI/reports. Failure preserves local work/prior saved content without claiming hospital writes. | M-09,11,13 |
| P2-09 | Unsaved new objects/changed targets require a reference commit or related-edit discard before AI selection; unaffected saved objects remain selectable. Interleaved AI/manual edits follow M-09/13 conflict checks without last-writer overwrite. Reload/task/account changes invalidate old bindings, and late results cannot update new targets. Every editor respects object/descendant locks. | M-09,13 |

<a id="cross-day"></a>
## Cross-day confirmation semantics

A day 3 replacement within a shared admission-day 3–4 phase first locates phase/items and resolves date basis, duplicate names, and group effects. The clinician chooses whole phase or day 3 only. Day-only changes preview resulting ownership, predecessors/successors, links, locks, and evidence before one reference transaction; recheck replacement specifications/dose/units/route.

An interior day, such as day 3 within days 2–5, previews day 2/day 3/days 4–5 while preserving surrounding content. Cancellation/save failure preserves the original. Confirmation cannot bypass cycles, dangling references, or invalid nesting. Complex P4 AI proposals share these semantics without requiring a running EMR window for DSH acceptance.

<a id="dependencies"></a>
## Data prerequisites and dependencies

P1 shared definitions, unsaved references, validation, and commits are prerequisites. P2 depends on neither P3 analysis, P4 AI, nor P5 reports. P2-A accepts the component against deterministic reference payloads; P2-B uses the same commit authority for manual editing, avoiding an AI/component dependency cycle.

Host integration carries authorized reference tasks/revisions/restricted actions and verifies source/window/account/task bindings, without generic hospital HTTP or credentials. Transport remains implementation design; identity binding and actual EMR integration checks cannot be replaced by an isolated example page. Dictionary reads also respect authorization; approved account reuse does not grant the assistant all EMR permissions.

<a id="acceptance"></a>
## Acceptance and stages

P2-A delivers separated components/read-only reference preview; P2-B completes manual operations, common commits, and recovery. Existing maintenance/review reuse retains its responsibilities without changed hospital save semantics from reference-mode work.

| Scenario | Observable pass condition |
| --- | --- |
| A: preview without management page | The same payload displays fully in management and modal/drawer hosts using one component without a selected list item. Unsaved/unknown-bearing drafts display without mutation or business writes on open/tab/close. |
| A: retain reference rather than reload | Where reference content differs from the hospital version, preview shows supplied values without ID-based replacement. Unread sections show coverage rather than empty collections. |
| B: basics/complete item editing | Edit header/departments/diagnoses/admission and all applicable single fields in EMR. DSH shows the committed revision without duplicate clinical forms, while hospital maintenance retains its workflow. |
| B: full copy/day-only edits | Complex copies have unique local identities/correct references. Both endpoint and interior-day changes affect confirmed scope only, preserving surrounding content and originals on cancellation/failure. |
| B: bundles/selection linkage | Dose changes affect one item; shared frequency previews all linkage. Selection/requiredness changes preview clearing/transfers and remain consistent after confirmation/undo; illegal nesting/incompatible grouping cannot pass. |
| B: prescriptions/links | Preserve header/three ingredients, identities/order/unit codes/names. Linked versions are exact, cycles terminate, unauthorized targets are not read, and removing a link does not delete its target. |
| B: unsaved selection/exit | Asking about an unsaved new item/changed medication requires committing/discarding related edits or continuing, without proposing against old values. Cancelling exit preserves the copy, discarding leaves the DSH draft unchanged, and failed commits remain actionable without hospital saving. |
| B: interleaved edits/locks | AI changes during EMR editing reject affected manual commits with differences. Independent entries may commit after rechecks. Descendant locks cannot be bypassed, and undo preserves independent edits. |
| A/B: disconnect/identity/retry | Disconnection does not imply commitment; reload rebinds. Task/account changes reject old responses/commits. Retried commits create one revision; unknown outcomes require status checks without falling back to hospital saving. |
| A/B: actual host/existing entries | Verify authorization/reference loading/save isolation in actual EMR, plus existing maintenance/review entries. An isolated shell demonstration does not replace this. |

Standalone preview sites/login products, PDF/Word editing, drag scheduling, and hospital writes are deferred. Complete structural editing remains mandatory in P2-B.

<a id="dev-note"></a>
## Dev Note

P2 implementation begins after P1 real-data verification and code publication. Start with a route-free single-pathway module and shared-payload read-only presentation; complete manual reference editing follows in P2-B. Hospital-data writes and backend changes remain outside scope.
