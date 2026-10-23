# Clinical encounter review

English | [中文](clinical-review.zh.md)

The experimental [encounter reader](../../packages/experimental/emr-encounter/README.md) exposes `ctx.encounterReader` for authorized, read-only evidence capture. The [clinical review plugin](../../packages/experimental/clinical-review/README.md) binds a private Session to one encounter and uses ordinary DSH turns to review its evidence. Review findings are advisory and never block discharge.

## Actor and encounter binding

`ClinicalActor` identifies the authenticated account by its runtime ID, issuer, and subject. `EncounterBinding` associates that identity with an authorized source system, hospital, and inpatient encounter. Browser launch claims require server authorization before they become a binding; model arguments cannot select the actor or replace the binding. The [reader broker](../../packages/experimental/emr-reader-broker/README.md) owns the current source authorization and capture implementation.

## Authorized directory

The browser-safe [directory records](../../packages/experimental/emr-encounter/src/directory.ts) use `DepartmentDirectory` for authorized labels and `PatientDirectoryRequest` / `PatientDirectory` for bounded inpatient pages. The broker binds department grants to the exact account issuer and subject, source system, hospital, and department. Current source records must be valid inpatients with state `4` or `5`. Browsing grants no additional permission and does not start review. The [broker README](../../packages/experimental/emr-reader-broker/README.md) owns grant configuration and query limits.

## Evidence snapshots

`EncounterSnapshot` contains immutable original sources, category coverage, a capture cutoff, and a content-derived case revision. Source state and coverage contribute to the revision. An empty supported query means no rows were returned; it does not establish clinical absence. Failed or cancelled capture publishes no accepted partial snapshot. The [source types](../../packages/experimental/emr-encounter/src/types.ts) define the exchanged fields.

## Saved results

The [clinicalResults projection](../../packages/experimental/clinical-review/src/result-projection.ts) recovers accepted reports and their original snapshots from retained Session plugin records without changing the persisted review format. The versioned [saved-result records](../../packages/experimental/clinical-review/src/result.ts), `ResultsResponse` and `ResultResponse`, distinguish the logical result, immutable report revision, finding identities, retained source quotations, progress, coverage, and freshness. Reading results neither invokes the model nor recaptures evidence; an unavailable historical snapshot is explicit.

Each saved-result read and rerun rechecks the owning account and current encounter permission. Exact encounter grants can be checked without the clinical database. Department grants require the current admission, so transfer, discharge, revocation, or source outage prevents access. A previously accepted report is not deleted when a later review fails. The [viewer plugin](../../packages/experimental/client-clinical-results/README.md) shares presentation between chat cards, the right panel, and an independent page; unverified EMR navigation stays unavailable.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxencounterreader--encounterreader-abstract-seam"></a>

### `ctx.encounterReader` — `EncounterReader` (abstract seam)

Providers reauthorize every capture and return immutable, bounded original evidence.

```ts cordis-catalog
/**
 * Capture one authorized encounter without modifying its source records.
 * @param actor - Authenticated transport identity; never model-selected.
 * @param binding - Previously accepted actor and encounter binding.
 * @param signal - Caller cancellation; dependent work stops before publication.
 * @returns Complete validated snapshot, or a typed failure with no accepted partial snapshot.
 */
abstract capture(actor: ClinicalActor, binding: EncounterBinding, signal: AbortSignal): Promise<EncounterSnapshot>
```

Source: [`packages/experimental/emr-encounter/src/index.ts`](../../packages/experimental/emr-encounter/src/index.ts)
<!-- END GENERATED cordis-surface -->
