# DRG/DIP review assistant V1 implementation proposal

English | [中文](drg-review-assistant-v1-implementation.zh.md)

Status: phased implementation proposal, 2026-10-22. The user has confirmed pre-discharge review as primary, separate DRG/DIP pre-grouping, and non-blocking discharge. Source-only DRG archives and optional private-runtime read-only sharing are implemented; the first EMR reader, private review Session, and manual browser entry are locally verified and awaiting user acceptance. Both grouping engines remain planned.

## Summary

Implement the [requirements](drg-review-assistant-v1.md) and [plugin design](drg-review-assistant-v1-plugins.md) on the existing [private workspaces](sso-private-workspaces-v1.md). Operations publish versioned shared references; private Sessions own evidence, confirmation, and results. Reuse DSH Web, profiles, scoped tools, skills, and durable records.

The complete independent national DRG engine remains a delivery goal; DIP has a separate resource and engine acceptance track. Evidence-review integration may proceed while engines are unavailable, but cannot count as grouping acceptance. The initial EMR integration uses one explicitly permitted test-department development encounter, the approved company gpt-5.5 service, and a replaceable read-only provider. Automated fixtures contain synthetic data only. MinIO, unrestricted patient access, payment prediction, claims submission, and production deployment remain outside this delivery.

## Table of Contents

- [Baseline and integration points](#baseline)
- [Resource storage and publication](#resources)
- [Runtime and Session integration](#runtime)
- [Implementation sequence](#sequence)
- [Validation and acceptance](#validation)
- [Compatibility and recovery](#recovery)
- [Decisions and progress](#decisions)
- [Dev Note](#dev-note)

<a id="baseline"></a>
## Baseline and integration points

The following integration points support the full plan; the progress table distinguishes implemented resources, first-stage local validation, and pending calculation work. The [plugin design](drg-review-assistant-v1-plugins.md#plugins) owns module responsibilities, trigger timing, and context transfer; business decisions stay outside the SSO gateway and generic API controllers.

| Existing owner | Intended use |
| --- | --- |
| [hosted-workspaces gateway](../../packages/experimental/hosted-workspaces/src/gateway.ts) and [identity state](../../packages/experimental/hosted-workspaces/src/state.ts) | Continue selecting the authenticated user's runtime. Do not add national rules, cases, or publication roles to login-session tables. |
| [runtime configuration](../../packages/experimental/hosted-workspaces/src/config.ts), [composition](../../packages/experimental/hosted-workspaces/cordis.patch.yml), and [runtime manager](../../packages/experimental/hosted-workspaces/src/docker.ts) | Add validated resource configuration and verify the exact read-only mount alongside existing private-home, network, user, and capability restrictions. |
| [Compose deployment](../../deploy/hosted-workspaces/compose.yml) and [entrypoint](../../deploy/hosted-workspaces/entrypoint.sh) | Keep the existing gateway/web launch through named profiles and supply runtime resource configuration without a second app entry. |
| [preset definitions](../../packages/preset/agent-preset/README.md), [tool registration](../../packages/core/tools/README.md), and [user questions](../../packages/interaction/user-questions/README.md) | Compose the proposed DRG conversation and trusted root-agent confirmation without modifying the agent loop. |
| [Session log](../architecture.md) | Persist versioned experimental business records and readable tool evidence separately; reconstruct accepted state through a pure projection. |
| [Agent entry points](../../packages/core/agent/README.md) and [MCP client](../../packages/mcp/mcp-client/README.md) | Wake accepted review events through followup; use inject only for context. A controlled reader retains authorization and evidence semantics across provider replacement. |

The runtime manager supports an optional `sharedResourcesPath`, passed through `HOSTED_SHARED_RESOURCES_PATH` by the deployment patch. It binds only the published collection at `/opt/dsh/resources`, read-only and non-recursively, alongside each private home. Reuse checks verify the exact mount; mismatches require operator-controlled recreation retaining the home volume. See [the runtime package](../../packages/experimental/hosted-workspaces/README.md#configuration) for the configuration and [the resource library](../../packages/experimental/drg-resources/README.md) for publication.

<a id="resources"></a>
## Resource storage and publication

### Storage and identities

The implemented first stage archives the original PDF, a strict manifest, and a standalone SQLite database containing source/version metadata only. Every pack has `profile: source-only` and `readiness.groupingReady: false`; its reference default does not activate grouping. The complete structured references, dictionaries, reviewed extraction, and deterministic TypeScript engine described below remain planned. SQLite is a read-only reference artifact, separate from patient data and the generic storage-domain KV backend.

The resource utility creates this layout below an operator-configured root. Published paths refer to the Docker daemon's host filesystem, which can differ from the gateway filesystem or a developer's computer.

```text
<server-data>/drg/
  staging/
  published/
    catalog.json
    <pack-id>/
      manifest.json
      reference.sqlite
      sources/
        national.pdf
```

### Complete grouping resources (planned)

The manifest identifies the resource schema, pack ID, national edition and applicability, source URLs and SHA-256 digests, dictionary editions and digests, derived-data revision, compatible engine versions, required files, source locations, and verification report. Structured resources cover MDC/ADRG/DRG membership, diagnosis/procedure lookups, precedence and exceptional conditions, CC/MCC and exclusions, and codes not used for grouping. File hashes detect changed bytes; trusted operator publication, rather than hashes alone, determines whether the package is authorized.

Use separate source and extraction revisions: correcting a misread table with an unchanged PDF creates a new pack revision, while an official replacement also changes its source digest. Referenced text retains physical/printed page and table/row locations. The 26/492/825 inventory is one completeness check, not proof that the rules, coding maps, or medical interpretations are correct.

DIP resources require their own source inventory, mode tag, dictionary/mapping compatibility, disease-match rules, and optional score-table identity with effective dates. Existing DRG source-only manifests do not support this by renaming a file. Any persisted resource-format extension requires explicit readers and compatibility review; do not rewrite existing immutable archives.

### Publication and reads

1. An operator prepares a candidate in unmounted staging storage. Obtain the exact dictionaries, audit layout-sensitive extraction, and record professional review and independent benchmark coverage. Synthetic test packs are explicitly labeled and isolated from national-pack activation.
2. The publisher validates schemas, expected inventory, references, dictionary/engine compatibility, required rule paths, file hashes, and the completeness report. Accept only normalized relative resource filenames; reject traversal or links escaping the collection, and keep unrelated filesystem mounts outside the published tree. Missing required material leaves the candidate inactive; neither the model nor a running user tool may publish it.
3. Close and finalize the SQLite artifact without dependence on live WAL/SHM side files, then durably publish a new uniquely named directory on the same filesystem. Reject an existing pack ID with different bytes. Only after the files are complete may an atomic catalog update select it as an available revision/default.
4. Mount only the published collection into personal containers with read-only Docker access; open the database read-only as well. Staging, publisher credentials, private homes, and the Docker socket are never part of this mount. Reads use bounded feature operations and identifiers, not arbitrary paths or SQL supplied by the model.
5. Resolve the default at accepted case import and record the exact pack and file identities in its logged feature state. Recheck that revision's integrity, availability, and compatibility before confirmation and result publication. A concurrent default change alone does not change or invalidate that case's binding.
6. Roll back the default by selecting a previously verified revision, without rewriting resources or Sessions. Withdrawal changes catalog availability, not pack bytes; on resume or the next operation, expose the withdrawal through recorded feature output, invalidate current eligibility, and retain historical evidence. In-flight calculations must recheck availability before publishing.

This design uses [Docker read-only mounts](https://docs.docker.com/engine/storage/bind-mounts/) and [SQLite read-only connections](https://www.sqlite.org/uri.html). Published pack files remain immutable even to the publisher; replace a revision with a new revision, not a live edit of a mounted database. The catalog is mutable publication metadata and is validated separately from immutable pack contents.

### Ownership, backup, and later distribution

Only a designated server operator can write staging, published resources, and catalog metadata. A company SSO login or ownership of a personal DSH runtime does not grant publication rights. Users may inspect public national references, but cannot install a version for everyone or substitute their private copy as the published source.

Back up source files, every retained published revision, catalog metadata, and verification reports outside the server; back up account mappings and each private home under their existing separate access controls. Verify hashes and restore catalog/file consistency before enabling grouping. Keep all versions referenced by retained cases; no automatic pack deletion or backup migration is part of V1.

If several servers later need the same collection, MinIO can distribute unchanged versioned artifacts. Each server can fetch and verify a package before local read-only use. That extension must preserve pack IDs and case bindings; first-delivery lookup does not depend on MinIO availability, bucket policy, or user-container storage credentials.

<a id="runtime"></a>
## Runtime and Session integration

Implement the four capabilities and scoped tool set defined in the [plugin design](drg-review-assistant-v1-plugins.md#plugins). Keep encounter authorization in the trusted reader, accepted review state in the private Session, and versioned national references in the read-only collection. The grouping providers consume confirmed mode-specific snapshots and never fetch raw patient records.

The design specifies [context fields](drg-review-assistant-v1-plugins.md#context), [tool calls](drg-review-assistant-v1-plugins.md#tools), and [confirmation/recovery](drg-review-assistant-v1-plugins.md#state). Implement their identity, revision, logging, and cancellation requirements together; neither a preset nor a successful login supplies patient authorization. General chat capabilities remain unchanged.

The EMR discharge transaction is independent of review execution. Integration acceptance must fail if waiting for the model, data reader, human response, or grouping changes the original discharge success/failure outcome. Review failures are displayed separately with a retry path.

<a id="sequence"></a>
## Implementation sequence

Each phase is a bounded outcome, with integration points, prerequisites, acceptance evidence, and recovery. The phases include implemented resource sharing, the authorized first-stage evidence-review work, and the remaining complete V1 work. The progress table records their current state; a phase listing does not grant production deployment permission.

| Phase | Work and likely owners | Dependencies and observable acceptance | Failure, recovery, and coordination |
| --- | --- | --- | --- |
| P0: resource and interface readiness | Verify DRG and DIP sources/dictionaries/rules, R1-R3 checks, and independent cases; verify EMR launch, identity mapping, source revisions and execution coverage. | Produce separate readiness inventories and designate the permitted development case. Synthetic interface work can proceed before live access. | Missing sources block the affected engine, not independent review work; missing patient authorization blocks actual patient reads. |
| P1: build and validate resource artifacts | New feature-owned manifest/reader/publisher modules plus source/extraction verification assets; keep resource production separate from runtime inference. | Depends on the resource specification from P0; mechanics can use isolated synthetic fixtures. Valid candidates publish completely, while hash, dictionary, coverage, or path errors stay inactive. | Preserve staged failures for inspection without changing the active catalog. Existing published IDs are immutable; retain the previous default for recovery. |
| P2: integrate private runtimes | Update hosted-workspaces config, composition, runtime provisioning/inspection, deployment wiring, and their owning tests for one configured read-only collection. | Follows the P1 layout. Two personal runtimes read identical pack identities; real file/command tools cannot modify the collection, see staging, or access another private home. | Disable the optional resource configuration to preserve general-workspace behavior. Plan explicit replacement of old runtime containers, retaining homes and accounting for active work; do not delete them from ensure() on a mount mismatch. |
| P3a: complete DRG engine | Implement the pure national DRG library and registered provider with traceable rules and input validation. | Requires verified DRG resources from P0/P1; meet DRG-08/09/10 and AC-09/10/14 independently of model output. | Never activate partial national coverage; preserve the prior verified engine/resource combination. |
| P3b: DIP provider | Implement disease matching and explicitly scoped scoring for the selected edition, with independent validation assets. | Requires DIP resources from P0/P1 and meets DIP-01/02 and AC-20/21. Return explicit unavailable scoring when score resources are absent. | No DRG substitution or reuse of unverified EMR payment constants; localize failure to the DIP mode. |
| P4: private review and evidence access | Implement the controlled reader, Session binding, immutable evidence, R1-R3 review, per-mode revisions and human confirmation. | Requires P0 interface definitions and resource identities; test explicit missing resources, foreign encounters, stale references, and interrupted receipts. | Log accepted state before publishing it; preserve prior state on failures; refresh access authorization on resume. |
| P5: tools, skills and EMR entry | Compose the scoped tools, common/mode skills, readable reports and authenticated event bridge; use the real SSO/company-model development path for the designated case. | Requires P4; review can show computation unavailable until P3a/P3b are ready. Calculation acceptance additionally requires its provider. | No automatic full review on patient opening; deduplicate events, retain current revisions, and never block discharge. |
| P6: integration verification | Run focused behavior tests, keyless recorded-session scenarios, and real Docker/Web flows. | Cover AC-01 through AC-26, both modes, multiple users/Sessions, provider replacement, revisions, resume/fork, persistence failures, unavailable drafts, and non-blocking failure. | Report review, provider, resource, and model evidence separately; an incomplete engine prevents its complete acceptance. |
| P7: rehearse release and user acceptance | Resource publication/default rollback, backed-up runtime replacement, off-server backup restoration, and user-reviewed scenarios. | Requires P6 and operator-selected server paths/backup destination. A restored old case retains evidence and exact resource identity; users explain expected versus actual normal and failure outcomes. | Confirm a supported image/feature-schema/resource combination before rollback. Keep previous containers/images/configuration and data backups until acceptance; company deployment or destructive cleanup needs its own authorization. |

Dependencies: P0 identities/interfaces → P1/P4; P1 → P2 and the independently resourced P3a/P3b; P4 → P5 evidence-review integration; each ready engine then joins P5 calculation integration. P6 verifies each delivered track, while full dual-mode acceptance requires both engines; P7 follows the accepted tracks. Existing P1 source archives and P2 mounts are reused rather than rebuilt. Plugin interfaces and write ownership must be fixed before parallel implementation.

<a id="validation"></a>
## Validation and acceptance

The [requirement acceptance table](drg-review-assistant-v1.md#acceptance) owns behavioral expectations. Record repository revision, worktree changes, selected resource/engine/dictionary identities, environment, actual commands, and results for each implementation validation run. A published PDF, a passing schema check, or a successful model response alone is not engine or clinical acceptance.

| Evidence | Required positive and failure coverage |
| --- | --- |
| Resource validator and deterministic engine | Required inventory and every DRG's independently reviewed reachable case; negative/boundary cases, exclusions/precedence, missing mappings, corrupt hashes, incompatible engines, and missing/withdrawn resources. A CLI path for publication/validation must run the same validators as runtime admission. |
| Private workflow and logged replay | Exact original-message import, evidence/cutoff/revision validation, same-case IDs in different users/sessions, accepted versus unrecorded confirmations, concurrent revisions, default publication versus explicit rebinding, restart, and historical explanation after updates. |
| Docker and Web | Real SSO/gateway/runtime routing, two accounts, multiple chats, real read-only write attempts, no access to staging or peer data, root-agent confirmation, cancellation, restart/recreation, report rendering, and backup restoration. |

Use focused resource/feature tests, owning runtime tests, and keyless recorded-session snapshots during development. Before completion of code changes, run build artifacts/checks as required by the repository, documentation checks for changed docs, and the real model/Web path for model-assisted review. If a PR changes visible GUI behavior, include the repository-required real-flow GIF; a static screenshot or mock result is not that evidence.

Operator acceptance includes interrupted staging/publication, default rollback during a waiting case, withdrawal before in-flight result publication, full-disk/missing-resource errors, and restored historical cases. Independent user acceptance includes normal, contradictory, missing-execution, stale-confirmation, cross-user denial, and unsupported-version scenarios. Leave the implementation explicitly awaiting user acceptance until those outcomes are reviewed; professional rule/case approval is separately required for clinical claims.

<a id="recovery"></a>
## Compatibility and recovery

Adding shared national references does not migrate existing conversations into a common database or merge private volumes. Keep current SSO identifiers, private-origin routing, runtime isolation, and browser-session semantics. Resource mount validation must admit exactly the configured national collection without weakening checks for other mounts, host privileges, or peer networks.

Use an optional feature composition so ordinary conversations work with the current resource-free setup. Existing runtime containers need a planned recreation to add the mount/configuration, not a blind restart or automatic deletion. Preserve their home volumes, back up gateway identity mappings, account for active processes/interactions, and verify retained history before replacing additional containers.

Published resource rollback and application rollback are separate operations. Changing the default affects new cases only; retain old pack revisions and readable logged evidence. Before an image rollback, verify it can read the persisted feature-record schema; otherwise pause new DRG work and restore a supported image/configuration without replacing accepted history. Generic historical tool text can remain readable even when recomputation is unavailable.

Before any released Session discriminator or externally visible configuration/API is changed during implementation, follow the repository's persistence acknowledgement, migration, upgrade-guide, and consumer-update rules. This proposal does not authorize destructive data conversion or assume an older application can interpret new feature metadata.

<a id="decisions"></a>
## Decisions and progress

| Subject | Current decision or dependency |
| --- | --- |
| User-confirmed | Pre-discharge review as primary; separate DRG/DIP pre-grouping; non-blocking discharge; company SSO and company gpt-5.5; one authorized test-department development encounter; private runtimes and versioned server references. Preserve the independent complete DRG-engine goal. |
| Implemented storage choices | Original PDF plus source-only SQLite metadata, strict manifest/catalog schemas, an operator-only publisher, and local read-only mounts without MinIO. Complete structured grouping packages remain planned. |
| Open dependencies | The [design dependencies](drg-review-assistant-v1-plugins.md#validation): EMR-side event installation, approved clinical checks, exact DRG/DIP resources and dictionaries, and professional reviewers. The pilot uses a single-encounter allowlist; it does not implement hospital-wide patient permissions. |
| Deployment details deferred | Actual Linux host/domain/TLS, server resource root, backup destination, maintenance window, and company deployment authorization. These do not block resource-format or local Docker work. |
| Current progress | P1 source-only archives and P2 optional mounts are implemented. P4/P5 first-stage encounter reading and manual advisory review are locally verified, pending user acceptance. P0 complete readiness, P3a/P3b engines, structured human confirmation, EMR-side installation, and clinical acceptance remain incomplete. Earlier local evidence is recorded below and does not establish clinical acceptance. |

Estimates do not imply that missing sources, professional review, or complete engine baselines exist. The approved development test-data scope does not grant unrestricted patient access, institutional report authority, or production deployment permission.

<a id="dev-note"></a>
## Dev Note

On 2026-10-23, the user confirmed the product name “医保助手”, a clinician-readable result Sidebar and system prompt, an independent clinical preset without the coding workflow, preservation of general tools, and a local rebuild/restart for review. The implementation now puts findings, source quotations, and clinician actions first, folds technical identifiers into details, and uses a separately declared clinical preset. Clinical conversations use their configured directory without asking clinicians to select a workspace; model blocks and existing authorization remain enforced. Focused unit tests, the keyless clinical Session replay, root/prefix browser cases, final build/check, and lint passed. The local gateway and private instance run the rebuilt Linux image, with their volumes, authorization policy, and old containers retained; the browser shows the new welcome and saved-report presentation. Documentation checks retain the existing repository-reference failure in `python/sdk/uv.lock`; the CLI-help environment warning and stale generated client catalog were resolved and their checks passed. Existing standard-preset Sessions and saved report text are retained; no new real-patient model review was run. Readable findings and citations, missing-data and changed-record states, historical results, and the new clinical entry are ready for independent user acceptance.

Extension consolidation is implemented after the clinical result viewer merge. Synyi brand and theme are separate from shared defaults; new clinical Sessions use a generated `clinical-review` preset with the existing general-tool and company-model policies. Existing Sessions keep their recorded preset; no retained data is converted.

The independent work units are theme extraction, brand extraction, and clinical-preset generation. Deployment composition follows those units; local build, Loader composition, recorded-session replay, and browser checks validate the integrated result. The existing clinical plugins, result viewer, patient authorization, generic page registration, and shared UI fixes remain their current owners. No commit, push, or deployment is part of this implementation.

Acceptance requires the Synyi profile to retain its appearance and page assets, the ordinary Web composition to use upstream defaults, new clinical Sessions to receive the clinical role with existing tools, and historical reports to remain readable. Local validation passed on macOS on 2026-10-23, using the `main` worktree with the consolidation changes: focused tests, recorded-session replay, runtime dependency checks, `build:artifacts`, subsequent `build:check`, and lint. Two clinical-result browser scenarios verified the new preset, general tools, report history, and revoked access; three presentation scenarios passed twice through the CLI dependency closure, covering root and proxy-prefix routes, first paint, dark reload, theme changes, and default Web isolation. An authenticated source-CLI smoke served the packaged brand metadata and manifest from an isolated profile.

`doc-sync` passed 42 checks with only the existing repository-reference failure in `python/sdk/uv.lock`; hygiene passed 20 checks with the existing vendor-rescope failure. The company-local gateway and active private runtime now use `dsh-hosted-workspaces:clinical-preset-20261023`, layering the verified portable artifacts over the existing Linux image with unchanged external dependencies. Gateway and home volumes were backed up and retained; the current department policy, prior containers, and unrelated environments were preserved. The browser reconnected with its existing login, retained chat history, Synyi presentation, `Clinical review`, and company `gpt-5.5`. No new model review was started; fresh SSO login, full Docker compilation, and external deployment remain unverified. Implementation is complete, pending independent user acceptance. The [upgrade guide](../upgrade-guide/v0.2.1-rc.2/synyi-web-composition/guide.md) records the explicit composition and retained-Session behavior.

Validated on 2026-10-22 on branch `codex/sso-private-workspaces`, using local macOS publication and a Linux Docker trial on port 38080. The official PDF is archived as `chs-drg-3.0-source-r1`, SHA-256 `82b5d179d797e2b9586b337d628c20177c85f43738529159c906fd0ef8432e41`, with source-only SQLite metadata and `groupingReady=false`. Publication also passed inside a non-root Linux container. The trial uses synthetic OIDC/model services independently of the existing company SSO environment.

Focused resource/runtime tests passed: 375 tests, with 100% statements, branches, functions, and lines for the new resource library and changed configuration/runtime composition files. The 15-check real Docker flow verified Alice/Bob and a new Session reading the same source, Bash/file/SQLite write denial, exact read-only mounts, no staging/peer access, gateway restart, and retained home/history after personal-container recreation. Offline CLI checks covered duplicate-ID and bad-digest rejection, two revisions, default rollback, withdrawal/restoration, unchanged source bytes, and copied-backup verification. The authored `shared-national-reference` Session snapshot replayed through the shipped headless profile.

The complete build and lint passed. Documentation quick/full checks passed except the existing repository-reference violation in `python/sdk/uv.lock`; hygiene has an existing vendor-rescope failure outside this change. These checks do not establish complete national rules, clinical validity, a clean full Docker image build, company deployment, or independent user acceptance. The local runtime image layers the rebuilt gateway onto the existing Linux image. Implementation is complete for this source-sharing stage, pending user acceptance.

The user subsequently requested the existing company SSO and real DeepSeek for normal reference chats. The local company portal on port 8080 now enables the shared mount and bundled reference skill; the image includes Poppler. Existing account/home volumes were backed up and retained, and old stopped personal containers were retained for rollback. A fresh standard-preset chat loaded the skill without a marker, verified manifest/PDF digests, read the original with `pdftotext`, and correctly cited CHS-DRG 3.0, 26 MDC entries and their first three names at physical PDF page 19 (printed page 1). The initial upstream failure was traced to missing external DNS in the local Docker VM; an explicit resolver on the company gateway restored an authenticated model-list response and successful streaming. This proves local technical integration for source reading, not clinical or complete-grouping acceptance. The mock environment remains a separate automated-test fixture.

The user authorized first-stage implementation, selected company gpt-5.5, and delegated selection of one development test-department encounter. The replaceable reader performs fixed parameterized queries in a read-only transaction; the gateway owns database credentials and checks the authenticated actor against an operator allowlist. Clinical review owns a private encounter Session, evidence revisions, exact read citations, durable event admission, and advisory reports. Browser entry supports manual identifiers and trusted-window messages. Complete DRG/DIP calculation, structured human confirmation, EMR-side event installation, and clinical acceptance remain pending.

The local company-SSO/company-gpt-5.5 manual flow produced a durable advisory report on 2026-10-22: six findings, 28 independently checked exact quotations, and 15 fully read sources out of 169 available entries; the remaining 154 stay explicitly unreviewed. A proposal claiming full review of unread content was rejected before the model corrected it. The browser distinguishes accepted work, ongoing review, missing reports, output truncation, and a generated report pending human review. A foreign account and an unauthorized encounter both returned 403. Database capture includes diagnoses, orders, and readable documents; unsupported execution/check sources and unread document bodies remain coverage gaps. This proves the bounded technical flow, not clinical completeness or accuracy.

This long-history run used a 128K configured context, 32K model output, 16K compaction headroom/summary output, 4K retained recent history, and low reasoning. Manual and automatic compaction succeeded; the successful review turn took about 8.5 minutes, so latency remains unoptimized. Local validation uses rebuilt artifacts layered onto the existing Linux image. Actual EMR-side event installation and a live cross-window embedding round trip remain unverified; the local embedding popup was blocked by browser automation policy. Server deployment, a clean full Docker build, structured human confirmation, complete DRG/DIP engines, and clinical acceptance remain outstanding.

The final local image passed artifact and aggregate build checks. Focused validation passed 25 clinical-review tests, 39 client-entry tests, 12 reader tests, 361 hosted-workspace tests, nine company-preset tests, and the clinical recorded-session replay. Recreating the gateway and personal containers with retained volumes restored the same report revision and browser status; independent checks confirmed unchanged report and evidence digests and all 28 quotation offsets. This implementation stage is complete pending user acceptance. The full documentation gate still has an unrelated repository-reference failure in `python/sdk/uv.lock`.
