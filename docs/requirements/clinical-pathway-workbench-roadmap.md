# Clinical pathway assistant: phased PRDs and repository ownership

English | [中文](clinical-pathway-workbench-roadmap.zh.md)

Status: P1 implementation and bounded independent review are complete on 2026-10-27: EMR-owned definitions, DSH reference persistence, and lightweight previews. User business acceptance remains pending. P2–P5 remain deferred. No commit, push or deployment is authorized.

## Summary

Clinicians select authorized scope, inspect history, and create/accept AI changes in DSH, then fully edit the same reference in EMR business context. EMR shared definitions own clinical content; DSH lightly displays structure/differences/evidence/questions, and reports bind the same revision. Five independently acceptable tasks remain, governed by [shared data/operation requirements](clinical-pathway-workbench-model.md).

## Table of Contents

- [Confirmed direction and current facts](#basis)
- [Data and frontend ownership](#ownership)
- [PRD split and dependencies](#split)
- [Recommended stages and coverage](#stages)
- [Acceptance and open decisions](#acceptance)
- [Dev Note](#dev-note)

<a id="basis"></a>
## Confirmed direction and current facts

Confirmed ownership/access carry forward without being reopened for user choice. Shared extraction, separated components, and reference integration remain unimplemented.

| Category | Contents |
| --- | --- |
| Confirmed clinical goal | Clinicians/pathway owners, new and exact-version revision tasks; a complete first demonstration with simplified detail, without reverting to long Markdown or one medicine card per day. |
| Confirmed architecture | EMR owns clinical data structure; planning includes shared definitions and single-pathway component separation. Complete manual editing belongs to emr-app, DSH retains AI changes/acceptance/lightweight preview, without a duplicate complete editor. |
| Confirmed authority | Read-only analysis/reference artifacts; no hospital drafts/business versions, pathway/patient/chart/order writes, review, or publication. Live development access remains hospital 1001/department 99999/latest year/current-department basis, with fixed endpoints/timezone per task. |
| Existing access/evidence | [V1](clinical-pathway-assistant-v1.md) and its [implementation record](clinical-pathway-assistant-v1-implementation.md) describe three tools/local read demonstration. Six encounters/nine executions, a management reference, and restoration checks do not establish treatment-proposal or clinical acceptance. |
| EMR source facts | The exported single-pathway component has viewMode/review reuse but constructs business datasources, reads by business ID, and contains save/review actions. Serializers convert DTOs/component models; verified cross-repository shared definitions do not yet exist. |
| Recommendations | Task allocation, P2-A/B depth, and order. Clinical direction/UI ownership are confirmed; detailed behavior/acceptance awaits review. |

Development reuse of the existing account with fixed SQL/enforced read-only transactions is approved without requiring a new account. EMR login grants no additional assistant access. Orthopedics remains an example. Future EMR frontend work is planned; this round changes no EMR files/backend/business APIs/deployment.

<a id="ownership"></a>
## Data and frontend ownership

This table records confirmed ownership, detailed in M-00/13. EMR owns extraction of shared definitions; this project does not define another clinical schema.

| Content | Owner/consumption |
| --- | --- |
| Shared clinical fields/enums/necessary validation | EMR owns one identifiable version consumed by both sides, excluding Angular runtime/patient execution/review state while supporting unsaved references, unknowns, and complete coverage. |
| Reference tasks/content/baselines/revisions | A private DSH task owns saved reference state. Clinical content uses EMR definitions; metadata retains sources/coverage/proposals/locks without duplicate clinical content. |
| Complete manual editing/single-pathway view | One emr-app component hosted by management pages/modals/drawers, with host-provided data/actions and no hospital-write capabilities in reference mode. |
| AI dialogue/changes/acceptance/light previews/reports | DSH owns these even when embedded. EMR provides host entry/restricted context binding. AI/manual edits share commits; AI does not require an online EMR window. |
| Hospital saving/future writes | Existing business hosts retain hospital workflows. Reference mode never invokes them. New import/write requirements remain separate and are not authorized by acceptance/reference saving. |

<a id="split"></a>
## PRD split and dependencies

Keep five PRDs: P1 shared definitions/reference data, P2 native EMR consumption/editing, P3 department analysis, P4 controlled AI changes, and P5 inspectable handoff, without mechanically splitting frontend/backend into platforms.

| PRD | Independently acceptable result | Prerequisites | Deferred scope |
| --- | --- | --- | --- |
| [P1 EMR shared definitions/reference drafts](clinical-pathway-workbench-p1-draft.md) | Both consume shared clinical data; DSH creates/restores tasks and lightly inspects structure/differences with common commits. | Existing EMR models/serializers and reader/Sessions; no P2 completion dependency. | Actual component display in P2-A, complete editing in P2-B. |
| [P2 EMR component/complete reference editing](clinical-pathway-workbench-p2-structures.md) | A previews supplied references without management pages/hospital IDs. B commits all manual fields/complex changes to one revision while preserving hospital maintenance. | P1, authorized host binding/dictionaries; no AI/analysis/report dependency. | Separate preview products/hospital writes. |
| [P3 History/candidates](clinical-pathway-workbench-p3-analysis.md) | Verifiable history, cohort reuse, and candidates; draft edits leave statistics unchanged. | P1 scope/evidence identities and three existing tools. | New execution sources/historical trials. |
| [P4 AI creation/controlled changes](clinical-pathway-workbench-p4-assistance.md) | DSH creates/revises proposals with individual/batch/defer/undo under EMR semantics. | P1; P3-A for history; complex operations require corresponding P2-B semantics acceptance, not a running editor. | Unsupported clinical parameters remain unresolved; no autonomous treatment approval. |
| [P5 Reports/structured handoff](clinical-pathway-workbench-p5-handoff.md) | Revision-bound reports, EMR shared payloads, metadata, differences/gaps; verified component consumption without hospital-save claims. | P1, referenced P3/P4; P2-A for actual consumption. Retained complex structures do not require P2-B; actual transformations need their accepted semantics. | Hospital imports/write DTOs/official numbering/versions. |

Dependencies are P1 → P2-A → P2-B; P1 → P3; P1 plus P3 when used → P4-A; P4-A plus relevant P2-B → P4-B; P1 + P2-A + referenced results → P5-A, without a P2-B prerequisite for retained complex content; actual transformation results require relevant accepted semantics. P5 supplies no required upstream data, and deterministic examples let P2 proceed without AI, keeping the graph acyclic.

<a id="stages"></a>
## Recommended stages and coverage

Accept P1 first, then advance P2-A/P3-A independently. P4-A/P5-A then demonstrate both new/revision tasks with EMR previewing the same draft. Continue P2-B complete editing/P3-B, then P4-B/P5-B. A/B indicate depth, not permission to omit structures.

| Milestone | Observable result | Limit |
| --- | --- | --- |
| M1: P1 | Shared data passes both consumers; DSH task creation/version binding/persistence/restoration/light previews are inspectable. | Component integration awaits P2-A; no complete DSH forms. |
| M2: P2-A + P3-A + P4-A + P5-A | Authorized scope → history → new/revision reference → AI changes/accept/undo → DSH lightweight and EMR modal/drawer checks → report/shared-data handoff, exercising both intents. | Complete manual editing/complex AI transforms follow; no clinical approval/hospital-write claims. |
| M3: P2-B + P3-B + P4-B + P5-B | Complete EMR manual/complex DSH AI edits interleave on one reference with conflict/lock/reconnect/structure/report consistency. | Hospital saving/business versions/publication/historical trials remain separate. |

Clearly labeled synthetic pathways/dictionaries may supplement coverage without expanding live reads. Simple AI demonstrations modify supported objects only, preserving existing complex content. EMR preview must display represented complex structures without trimming them and claiming completeness. Move P2-B earlier if the first demonstration requires manual complex edits.

| Confirmed capability | Data requirements | Behavior/acceptance owner |
| --- | --- | --- |
| Header/departments/stay/cost/diagnoses/admission | M-03–04 | P1 representation, P2-B manual editing, P4 proposals. |
| Phases/dates/predecessors/single orders/clinical/nursing work | M-05–06 | P1 preservation/light preview, P2-B editing, phased P4 changes. |
| Bundles/selection/prescription header/herbs/phase links | M-07–08 | P1 representation, P2-A display, P2-B transformations, P4-B AI. |
| Shared fields/identities/unknowns/direct component consumption | M-00–02,10 | P1 extraction/data checks, P2-A actual component reference loading, P5 same-version delivery. |
| Statistics/candidates/sources/evidence | M-01,10 | P3, unchanged by edits and never automatically clinical standards. |
| Selected dialogue/multiple changes/defer/undo/discussion lists | M-09–11 | P4 using P1 commits; P2 retains manual clinical fields. |
| Cross-host revisions/locks/conflicts/save isolation | M-09,11,13 | P1 persistence authority, P2 host editing, P4/P5 exact-revision consumption. |
| Reports/structured handoff | M-10–13 | P5; current reference-consumption acceptance, deferred hospital writes. |

<a id="acceptance"></a>
## Acceptance and open decisions

Each delivery supplies runnable software, artifacts, and success/failure/edge evidence for user/clinical-owner expected/actual behavior and acceptance reasons. Report repository code, shared-data checks, actual EMR integration, and clinical quality separately. Document review does not replace user acceptance.

| Open decision | Recommendation/until confirmed |
| --- | --- |
| Q1 Initial depth | Recommend M2 AI/read-only EMR preview, with complete manual/complex operations in M3; move P2-B earlier when required. UI ownership/EMR data authority are confirmed, not reopened. |
| Q2 Clinical references/reviewer | Identify accessible guidelines/institutional standards/reviewer; an empty guideline tab is not evidence. Until supplied, accept structure/interaction only and retain clinical questions. |
| Q3 First live tasks | Select one new and one exact-version revision task within current access, identifying unacceptable outcomes. Until selected, synthetic structure examples grant no broader access. |

Findings/corrections/checks belong to the [review record](clinical-pathway-workbench-review.md). Concrete shared types/package location/transport are implementation prerequisites, not completed extraction/integration. Future execution verifies each repository's target/environment rather than treating read-only source branches as deployment mappings.

<a id="dev-note"></a>
## Dev Note

This round revises existing requirements/pairing records only, without code/tests/commit/push/deployment. Preserve clinical blue and the `#3664D9` reference: EMR components retain business styles, while DSH light previews reuse preset-local DSH components.
