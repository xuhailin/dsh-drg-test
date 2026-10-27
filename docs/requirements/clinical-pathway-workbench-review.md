# Clinical pathway assistant: requirements review record

English | [中文](clinical-pathway-workbench-review.zh.md)

Status: two independent reviews and correction checks completed for the 2026-10-27 EMR/DSH ownership revision; findings are closed. Detailed requirements await user review, without implementation or clinical acceptance claims.

## Summary

This round revised the [overview](clinical-pathway-workbench-roadmap.md), five PRDs, and [shared requirements](clinical-pathway-workbench-model.md) for confirmed EMR complete manual editing, DSH AI changes/acceptance/light previews, and EMR data authority. Two reviewers independent of authorship reviewed the revision afresh. After four workflow/dependency corrections, both passed their bounded correction checks.

## Table of Contents

- [Review scope and conclusions](#scope)
- [Findings and corrections](#findings)
- [Retained requirements and open decisions](#verdict)
- [Document checks in this round](#validation)
- [Dev Note](#dev-note)

<a id="scope"></a>
## Review scope and conclusions

The author changed existing requirements/pairing records only. Review covered confirmed UI/data ownership, shared extraction, component separation, task/dependency allocation, common revisions, and hospital-action isolation. EMR source was read-only evidence; no code edits, credentials, new patient queries, or deployments occurred.

| Perspective | Review/check result |
| --- | --- |
| Clinical workflow/acceptance | Retained complete fields, cross-day phases, bundles, prescriptions, links, and both intents. Unsaved selection, dirty exit, and complex-handoff dependencies were corrected; bounded recheck found no substantive contradiction. |
| Data/EMR compatibility/dependencies | EMR authority, DTO/runtime separation, unsaved references, common persistence, and action isolation hold. Version/gap handling and P5 prerequisites were corrected; recheck passed with no dependency cycle. |

<a id="findings"></a>
## Findings and corrections

PRD/model entries own behavior. This record retains implementation/acceptance findings without another field specification.

| Finding | Consequence | Correction/recheck |
| --- | --- | --- |
| EMR could send “here” for unsaved additions/changed targets absent from the saved DSH revision. | AI could target nonexistent objects/old values. | M-13, P2-09/P4-02, and scenarios require commit, explicit related-edit discard, or continued editing. Independent saved objects remain selectable. Clinical recheck closed the finding. |
| Close/task changes prohibited autosave without specifying dirty-copy handling. | Unsaved work could disappear silently or invoke old hospital saving. | M-13, P2-03, and exit scenarios add continue/discard/reference-commit choices. Failure/unknown outcomes stay actionable through P1 only. Forced reload promises no unsaved recovery or transfer to a new account. Both perspectives agreed. |
| P5 complex handoff required the complete P2-B editor. | Even simple edits of complex sources could not complete M2 delivery. | P5/overview now require shared validation plus actual P2-A consumption. P5-A preserves existing complex content; actual transformations need relevant semantics acceptance rather than every editing screen. Both rechecks closed the finding. |
| P1-08 blocked consumption for both unsupported versions and clinical unknowns. | Gap-bearing drafts needing discussion could not preview/handoff. | Unsupported versions reject consumption/commit. Unknown/incomplete/unmatched data within supported versions display without loss and allow selection/discussion/limited handoff, blocking only dependent operations. Data recheck closed the finding. |

<a id="verdict"></a>
## Retained requirements and open decisions

EMR owns clinical fields/enums without a second DSH schema/full editor. P1 accepts both data consumers, P2-A actual component preview, and P2-B complete manual reference editing. DSH AI does not require an EMR window. P1 owns all reference commits; hospital saving/numbering/review/publication remain separate.

Retain sequential-acceptance rechecks, three-interval interior-day preservation, group/shared selection/requiredness linkage, unknown medication parameters, coverage, and historical independence. Access changes limit new/source-dependent reads; saved material follows existing private policy without implicit export recall.

Both reviewers consider this revision ready for user review. Q1 initial manual/complex depth, Q2 clinical references/reviewer, and Q3 first authorized live tasks remain open; confirmed ownership is not reopened. Concrete shared types/distribution/transport/caller binding remain explicit implementation prerequisites, not implemented facts.

<a id="validation"></a>
## Document checks in this round

Checks apply to the confirmed main workspace. Only the existing eight requirements pairs/records change, excluding code, test files, the EMR repository, and deployment, without commit/push.

| Check | This round |
| --- | --- |
| verify-translation-pairing --write/eight-pair check | Revised pairs and post-correction corpus pairing passed. All eight records were refreshed; final checks cover the same content. |
| pnpm run test:docs | This round after corrections: 20 passed, one failed on the existing commit reference at python/sdk/uv.lock line 113. The lockfile is unchanged. Corpus links/wrap/pairing passed. |
| Set-specific links/anchors/newlines/whitespace/private-path checks | All links/anchors passed for the 16 Markdown files; all 24 files passed newline/whitespace/private-path/eight-pair line-count checks. |
| git diff --check/file digests | Whitespace diff checks passed. This round updates the existing 24 requirements files; other pre-existing changed files retain initial digests. Eight skill files changed status during execution; this round did not write them and preserves their content outside the requirements change. |

Requirements checks do not establish implemented shared definitions, runnable components, hospital writes, or business acceptance. No code builds or live business integration run in this round.

<a id="dev-note"></a>
## Dev Note

Future implementation must verify DSH/EMR target branches, environments, and evidence separately; this record grants no implementation authority.
