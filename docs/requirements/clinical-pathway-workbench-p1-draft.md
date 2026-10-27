# P1: EMR shared definitions and structured reference drafts

English | [中文](clinical-pathway-workbench-p1-draft.zh.md)

Status: P1 implementation and bounded independent correction review are complete on 2026-10-27. Business acceptance remains pending. See the [overview](clinical-pathway-workbench-roadmap.md) and [shared data requirements](clinical-pathway-workbench-model.md).

## Summary

Clinicians start a new reference task or an exact-definition revision in DSH and inspect a restorable draft, differences, and gaps. Clinical content uses EMR-owned shared definitions, with the same version powering lightweight DSH previews and later AI changes. P2's EMR component owns complete manual editing.

## Table of Contents

- [Task and scope](#scope)
- [Shared definitions and operation ownership](#requirements)
- [Dependencies and prerequisites](#dependencies)
- [Acceptance scenarios](#acceptance)
- [Stages and deferrals](#stages)
- [Dev Note](#dev-note)

<a id="scope"></a>
## Task and scope

The outcome is a recognizable, restorable, inspectable structured reference without requiring AI or a full editor to create a task. DSH supports selection, details, differences/evidence/questions, and EMR entry without clinical forms, phase scheduling, bundle editors, or prescription editors.

This PRD includes extracting EMR shared definitions and their consumption by both sides, plus DSH draft persistence/lightweight display. Shared definitions are pathway-specific necessities, not a generic form/state platform. Angular components, clinical repositories, and hospital save entry points stay outside DSH. Hospital drafts, official numbering, business versions, and writes remain excluded.

<a id="requirements"></a>
## Shared definitions and operation ownership

EMR shared definitions own clinical fields/structure rules. DSH owns reference tasks, baselines, revisions, proposals, locks, and common reference commits. P2's EMR working copy and P4's AI proposals submit candidate changes to that same authority without another saved source. Shared requirements are M-00–13.

| ID | Required observable behavior | Owner |
| --- | --- | --- |
| P1-01 | Extract serializable shared definitions from current EMR fields/enums, covering header/departments, diagnoses/admission, phases, work categories, containers, prescriptions, and links. Both consume one identifiable version, without a handwritten DSH clinical schema whose mapping is deferred until handoff. | EMR definitions; both consumers |
| P1-02 | Separate shared data from Angular instances, selection, patient execution, review workflow, and hospital HTTP. Verify normalizer defaults, display prefixes, inverted flags, and dropped fields. Defaults cannot turn unknown clinical content into known values. | EMR shared definitions |
| P1-03 | Keep source content, reference content, and AI metadata distinct. Preserve original sources without a second clinical-field copy. Shared definitions support unsaved objects/stable local references without placing local IDs/reference revisions in hospital ID/version fields. | M-00–02,10 |
| P1-04 | Reuse known intent/authorized scope. New references lack hospital identities; revisions bind exact definition/series/version/state. Reuse the three reader tools without relabeling old evidence after scope changes. | DSH; M-01 |
| P1-05 | Lightweight previews show multiple rows by phase/category, expand bundle/prescription/link relationships, select stable objects, and expose applicable fields, differences, gaps, and read-only JSON. Lightweight limits interaction rather than deleting structure or reducing a day to one medicine card. | DSH; M-03–11 |
| P1-06 | Save/restore one revision, baseline, metadata, and locks. Common commits verify current values/dependencies/scope/references/locks, atomically preserve prior content on failure, deduplicate retries, and preserve independent edits on undo. | DSH; M-09,11,13 |
| P1-07 | EMR reference edits and AI proposals commit to the same task. Previews/reports/conversation refresh to the actual saved revision. When EMR is unavailable, DSH retains saved inspection and supported AI operations while explicitly disabling complete manual editing. | Both; M-13 |
| P1-08 | Unsupported shared versions reject consumption/commits while preserving drafts. Incomplete sources, unmatched dictionaries, and unknown parameters within supported versions display without loss and allow inspection/selection/discussion/limited handoff. Block only transformations dependent on missing information, without lost fields, alternative schemas, or defaults. | Both; M-00,10 |

<a id="dependencies"></a>
## Dependencies and prerequisites

Existing EMR models, serializers, and components provide field evidence, not an existing shared package. They mix runtime types, numeric business identities, and execution state. Extraction must resolve unsaved references, unknown values, and complete field representation. Packaging/distribution remains implementation design, but a single source, version identity, both consumers, and necessary structure validation cannot be deferred.

Reuse the deployed reader/private Sessions. Incomplete dictionaries/templates allow explicit placeholders/questions without invented resolution. EMR login/opening an editor does not expand data access. Clinical references/acceptance remain overview Q2/Q3 prerequisites.

<a id="acceptance"></a>
## Acceptance scenarios

First accept shared data/private tasks. P2-A accepts actual component loading and P2-B complete manual editing. P1 delivery does not depend back on P2 completion.

| Scenario | Observable pass condition |
| --- | --- |
| Success: both consume one payload | One sample with header/admission, bundle→group→single, prescriptions, predecessors, and links passes both shared readers/structure checks, preserving clinical fields/enums/relationships/source values without a second clinical mapping inventory. |
| Success: new/revision tasks | Create a new reference without hospital identity and an exact-version revision. Preview/JSON/differences bind one revision without requiring EMR or generated prose. |
| Edge: unsaved objects/gaps | Multiple phases/herbs without hospital IDs retain distinct local identities and resolvable predecessors/metadata. Preserve zero, unknown/incomplete states, and code/name distinctions through normalization. |
| Edge: lightweight preview/EMR unavailable | DSH expands full structure/questions and selects same-name items distinctly without clinical forms. EMR unavailability preserves drafts and already supported AI commits. |
| Failure: unsupported version/incomplete source | Reject unsupported shared versions while preserving drafts. Unread sections do not become empty; locate dictionary/clinical gaps without write-readiness claims. |
| Failure: conflict/save/undo | Changed old values/dependencies prevent overwrites; unaffected remaining proposals continue under M-09. Retries, save failure, and dependent undo preserve consistent revisions/independent edits. |

<a id="stages"></a>
## Stages and deferrals

P1 first delivers EMR shared definitions, both consumers' data checks, DSH persistence/restoration, and lightweight previews as inspectable artifacts. P2-A then proves the single-pathway component displays that payload; P2-B adds complete manual editing. P4 adds AI operations and P5 pinned handoff, sharing P1 commits/definition versions.

Complete DSH forms, drag editing, and a duplicate EMR editor are not future completeness items; ownership is confirmed. Shared-package names, transport, and file layout remain implementation decisions without a generic platform.

<a id="dev-note"></a>
## Dev Note

EMR owns `src/app/core/models/clinical-pathway/definition/definition.schema.json`, generated declarations/schema values, and `readDefinition`. DSH consumes that version through the digest-checked mirror in [clinical-pathway-reference](../../packages/experimental/clinical-pathway-reference/README.md). Private Session revisions retain the original exact-source event, baseline, evidence, gaps and locks. The optional runtime composition and preset-local preview use the same state owner. P2 component integration, P4 proposal workflows and hospital writes remain deferred.

Verification uses the uncommitted DSH `main@056f983` and EMR `pg_develop@84ca9d7` workspaces. The EMR definition has 22 passing data scenarios; DSH has 57 passing reference/UI/Loader checks, including cold restoration. `build:artifacts` and `build:check` pass. The keyless Session snapshot and real Web preview smoke pass, including 390px light/dark layouts. Read-only verification used four authorized development-hospital/department definitions: 42 phases, 89 source items and 13 herbal ingredients. All 2,729 inspected fields/structures matched the EMR read APIs; four real Chrome creation/preview/restoration cases passed. Unread application details remain 32 explicit questions. The EMR inclusion-enum reversal and DSH sending-unit/current-drug-parameter projections were corrected. No hospital write API was called; clinical business acceptance remains pending.
