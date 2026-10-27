---
description: "Analyze pathway definitions and historical cohorts through three scoped read-only tools, with explicit evidence coverage."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-clinical-pathway-reader

English | [中文](README.zh.md)

## Summary

Analyze a selected pathway or prepare a new or revised reference proposal using authorized definitions, historical cohorts and encounter evidence. Queries retain source identities, filters and coverage limits. Only the clinical-pathway preset receives the three read tools; database credentials remain in the gateway. No hospital draft, business version or clinical write is created.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin as an authenticated gateway provider and as tools inside the optional `clinical-pathway-analysis` preset. It is not a bundle or executable. The [hosted overlay](../../../deploy/hosted-workspaces/compose.clinical-pathway.yml) selects the dedicated runtime composition; ordinary pathway and insurance-review compositions retain their existing behavior.

```yaml
- name: '@deepseek-ai/dsh-experimental-clinical-pathway-reader'
  config:
    mode: gateway
    sourceSystem: emr-pg-develop
    databaseConfigFile: /run/secrets/pathway-database.json
    policyFile: /run/secrets/pathway-policy.json
    schema: public
```

The database file accepts `host`, `port`, `database`, `user`, `password` and optional boolean `ssl`. Keep it outside model-readable files and mount it only in the gateway. The provider verifies the actual schema, required columns, SELECT access and enforced read-only transaction at startup and on every read. `readRolePolicy: select-only` additionally rejects writable roles or source ownership. Explicitly approved development integration may select `development-transaction-only` to reuse an existing non-elevated role; fixed SQL and verified READ ONLY transactions still reject writes. Neither mode changes the schema or role.

The policy is separate from current-inpatient grants. Its `schemaVersion: 1` object contains `grants`; each grant requires `issuer`, `subject`, `sourceSystem`, `hospitalCode`, `departmentCodes`, `departmentBasis` (`current` or `discharge`), `admissionFrom` and `admissionTo` as offset-aware ISO timestamps. `includeSharedDefinitions` defaults to false; true admits same-hospital shared department `-1`, without granting a standard hospital. One account/source/hospital has one grant; omitted hospital selection works only when exactly one grant matches. Empty grants deny access, and policy is reread before publishing results.

Inside the preset, `mode: tools` requires `brokerBaseUrl` ending in `/runtime/clinical-pathway/`; `runtimeTokenEnv` names the server-held runtime credential. The deployment generator enables this row only through its explicit reader opt-in. Do not mount the tools at profile root.

| Field group | Default | Meaning |
| --- | --- | --- |
| `mode` and role settings | Explicit | Choose gateway or preset tools; gateway paths and source identity or tool broker routing must be configured. |
| `readRolePolicy` | `select-only` | Default SELECT-only credentials; explicitly approved development can reuse an existing role inside enforced read-only transactions. |
| `maxRows`, `maxTextChars` | 200, 12000 | Bound child rows and document passages; requested page size is separately limited to 100. |
| `maxRowBytes`, `maxResponseBytes` | 65536, 262144 | Bound database JSON acquisition and complete response/model-visible output. Oversized reads fail visibly. |
| `timeoutMs`, `maxConcurrentReads` | 30000, 4 | Bound complete operations and gateway admission. Unloading aborts and drains active operations. |
| `herbalTables`, `operationTables`, `dictionaryTables` | false | Explicitly enable optional sources after schema and SELECT-grant checks. |

With `dictionaryTables`, the reader also captures current drug conversion and skin-test parameters from `v_cpoe_drug`, restricted to the granted hospital and returned order codes. These are current catalog observations, not historical version values. Duplicate, missing and partial matches remain explicit gaps.

The [configuration schema](src/config.ts) owns remaining bounds. Read failures preserve prior conversation evidence. Source unavailability is not a zero count or clinical absence; cancellation and timeout return actionable failures without SQL or credentials.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [gateway](src/gateway.ts) receives the authenticated runtime actor and live-login check. [Policy](src/policy.ts) supplies an admission window and department scope; model filters may narrow them. [Source checks](src/source-check.ts) pin the transaction search path and reject incompatible columns or unsafe roles. Fixed query modules read definitions, deduplicated historical cohorts and selected encounter categories; [shared query handling](src/query.ts) bounds JSON bytes before driver transfer. No user-provided SQL, identifier, actor or connection setting is executed.

[Tools](src/tools.ts) return versioned canonical JSON and pure generic read/search card intents. Normal tool/result and assistant/user messages retain evidence and reference revisions in the private Session; existing conversation and file tools provide discussion, edits and optional reference files. No new Session event or persistence type is introduced. Per-call snapshots do not span tools or pages; results retain filters, read times, scope, source connection timezone and coverage.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Requirements](../../../docs/requirements/clinical-pathway-assistant-v1.md) — reference-only behavior and acceptance.
- [Implementation plan](../../../docs/requirements/clinical-pathway-assistant-v1-implementation.md) — source fields, joins and delivery status.
- [Hosted workspaces](../hosted-workspaces/README.md) — authenticated private runtime transport.
- [Reader broker](../emr-reader-broker/README.md) — shared bounded PostgreSQL transactions.

-----

<a id="model-experience"></a>
## Model Experience

### Pathway evidence

#### What the model sees

`pathway_read` searches or expands an exact definition. `history_query` reports whole-cohort source counts or bounded evidence pages with explicit denominators. `case_read` selects encounter, diagnoses, orders or readable persisted document text; document inventories and passages have separate continuations. Results are logged canonical JSON, including partial coverage and unsupported sources; no write or approval tool is exposed.

#### Token effect

Only requested bounded query results enter the model history. Repeated pages and reference revisions add context; truncation and missing evidence remain explicit rather than implying a complete review.

#### KV Cache effect

The optional preset adds its stable tool schemas and reference instructions. Tool results and conversation revisions append normal history; changing source scopes or activating the reader can change request content. There is no private unlogged model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Current constraints remain visible in every analysis.

- Laboratory, examination, operation-execution and administration sources are unsupported. Missing `record_text` does not establish no document; object-storage bodies and native FormV2 need separate adapters.
- System-marked completion and order records do not establish clinical task completion. Retained reasons are not an immutable historical variation stream.
- Nullable delete flags use explicit source-specific rules; source filters and connection timezone affect cohort interpretation. Neither separate pages nor calls share one global snapshot.
- Reference quality still requires accessible clinical references and user acceptance. Hospital draft creation, writeback, review and publication are outside this phase.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
