---
description: "Save private pathway reference revisions using EMR-owned data definitions and a lightweight preview."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-clinical-pathway-reference

English | [中文](README.zh.md)

## Summary

P1 saves a new or exact-source reference task in its private Session. EMR owns the clinical schema; DSH owns revisions, evidence, locks and the read-only preview. Hospital writes and the EMR manual editor are outside this package.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the [optional runtime patch](../../../deploy/hosted-workspaces/clinical-pathway.runtime.patch.yml), with a scope matching the separately authorized pathway reader and explicit request, history and byte bounds. The combined clinical composition mounts the same reference owner. Ordinary profiles do not receive it. Launch through `dsh` profiles. Open **Reference draft** in a `clinical-pathway-analysis` conversation to create or inspect a task.

The authenticated `api/pathway-reference` routes provide config, read, create, commit and undo. A revision task selects an exact logged `pathway_read` result, including its original source identity and capture time. A new task starts with unknown clinical parameters and empty collections. Saving waits for Session persistence; an unknown durability outcome blocks further operations until recovery. Forks retain the original owner and cannot inherit access to the reference task.

## Understand the implementation

The [EMR mirror](src/emr/source.json) records content digests for the schema, generated declarations, generated schema value and portable reader. Synchronize with `node scripts/sync-emr-definition.mjs --emr-root <emr-checkout>` from this package, or add `--check` to verify. Only import extensions are adapted for DSH; EMR remains the definition owner. The [importer](src/import.ts) maps logged source rows once, retaining unknowns and locatable gaps. Original rows remain in the Session.

The [state owner](src/state.ts) serializes operations, checks owner/preset/scope, and appends complete private plugin records. Three-way commits preserve independent fields and reject changed dependencies or locks. Undo creates a compensating revision. A small revision projection refreshes open previews; clinical content is returned only after the durability checkpoint. Failed refreshes retain the last confirmed content.

## Further Exploration

- [P1 requirements](../../../docs/requirements/clinical-pathway-workbench-p1-draft.md)
- [Shared data requirements](../../../docs/requirements/clinical-pathway-workbench-model.md)
- [Source reader](../clinical-pathway-reader/README.md)

## Model Experience

### Reference operations

#### What the model sees

The preset-local `pathway_reference` tool reads, creates, commits or undoes a reference. Every model-visible result uses normal logged tool output. Candidate definitions must use the EMR format/version and stable local IDs. The model cannot change user locks, including through undo.

#### Token effect

Full saved definitions and history consume tokens in proportion to their size; configured byte and revision bounds reject oversized operations before saving.

#### KV Cache effect

The preset adds a stable reference tool schema. Reads and saved changes append ordinary tool history, so changed references can change request content; no reference data is injected outside logged tool results.

## Known Limitations and Deferred Work

- The preview exposes clinical fields and JSON without clinical editing forms. The EMR editor is explicitly unavailable until P2. P4 proposal generation/selection and P5 handoff are separate work. Source coverage gaps remain visible; reference validation does not establish clinical correctness or hospital write eligibility. The shipped analysis window is explicit configuration and must be maintained with the reader policy.

### Dev Note

Synthetic contract, import, revision, UI and Loader tests cover P1 without a hospital database. Real clinical validation and the user's business acceptance remain separate.
