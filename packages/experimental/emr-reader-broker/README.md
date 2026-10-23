---
description: "Read allowlisted EMR development encounters through a gateway-only PostgreSQL broker without changing discharge behavior."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-emr-reader-broker

English | [中文](README.zh.md)

## Summary

Browse explicitly authorized development departments and inpatients, open an encounter, and capture original admission, diagnosis, order and document evidence without writing to EMR. Personal runtimes receive only their approved encounter data; database credentials and the binding key remain in the gateway. Missing document bodies and unsupported sources remain visible. This development allowlist is not hospital production access control.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the dedicated hosted gateway composition, alongside hosted workspaces. It has no package executable and is not a profile bundle. The runtime event supplies the verified account and live-login check; the broker refuses expired sessions and rechecks authorization before releasing evidence.

```yaml
- name: '@deepseek-ai/dsh-experimental-emr-reader-broker'
  config:
    sourceSystem: emr-pg-develop
    databaseConfigFile: /run/secrets/emr-database.json
    allowlistFile: /run/secrets/emr-allowlist.json
    bindingKeyFile: /run/secrets/emr-binding-key
```

The database file is JSON with `host`, `port`, `database`, `user`, `password` and optional boolean `ssl`. Use a dedicated SELECT-only account. Every capture additionally starts a `REPEATABLE READ READ ONLY` transaction. The binding-key file contains at least 32 characters; keep it stable across restarts and rotate it to invalidate old bindings. Mount these files only in the gateway, with operator-controlled permissions.

The allowlist JSON contains `schemaVersion: 1`, `entries`, and optional `departments`. Exact encounter entries require `issuer`, `subject`, `sourceSystem`, `hospitalCode` and decimal-string `inpatId`; `inpatCode` and `sourceVisitId` are optional verified mappings. Department grants require the same account, source and hospital fields plus `departmentCode`, and admit only valid current inpatients with source state `4` or `5`. The broker rereads policy on every operation. Empty grant lists authorize nothing; malformed or duplicate grants fail closed. Exact encounter grants remain independently valid, so remove the corresponding exact entry when replacing it with department-only permission.

The [configuration schema](src/config.ts) owns all limits. Defaults allow 500 records per supported category, 50 patients per directory page, 256 KiB per source body and 4 MiB for the complete response, with a 15-second request deadline and four concurrent requests. Exceeding a capture limit rejects the capture; no truncated snapshot is accepted.

A launch validates claimed identifiers and returns a five-minute, one-use grant bound to the account. Consume exchanges that grant for a signed encounter binding; capture revalidates the binding and current allowlist. Grants are memory-only and disappear on restart. Launch events do not modify discharge transactions, create model requests or establish a hospital authorization policy.

The [directory](src/directory.ts) lists only granted departments and pages their current inpatients using literal search and bound SQL values. It returns encounter identity, patient name and bed only; browsing creates no model request or additional permission. `/authorize` checks a signed binding without recapturing evidence. Exact encounter grants need no database read for this check; department grants require the current admission and reject transferred or discharged patients, revoked permission, and source outage.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [broker](src/http.ts) owns fixed `/runtime/emr/launch`, `/runtime/emr/consume`, `/runtime/emr/authorize`, `/runtime/emr/capture`, `/runtime/emr/departments` and `/runtime/emr/patients` POST routes. [Authorization](src/policy.ts) authenticates binding fields with a gateway-only HMAC key. [Fixed SQL](src/sql.ts) selects explicit columns using parameter values, verifies hospital ownership and joins document content through its parent record. No arbitrary SQL, path, URL or doctor override is accepted.

The [reader](src/reader.ts) hashes exact retained content, source metadata, coverage, binding and provider version into `caseRevision`; unchanged evidence retains that revision across capture times. `capturedAt` and `cutoff` record the current capture independently. It marks unavailable document text as unread and keeps order state distinct from administration evidence. It rejects overflow before publication, rechecks login before each query, and rereads authorization before returning. Cancellation closes the source connection; unloading stops requests and removes the runtime handler.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Encounter reader definition](../emr-encounter/README.md) — replaceable provider semantics.
- [Hosted workspaces](../hosted-workspaces/README.md) — SSO and private runtimes.
- [Clinical plugin design](../../../docs/requirements/drg-review-assistant-v1-plugins.md) — evidence review and Session ownership.

<a id="model-experience"></a>
## Model Experience

None, as this broker registers no model tools, prompts or Session content.

#### KV Cache effect

No direct effect; the clinical review consumer owns logged evidence and model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The allowlist authorizes development encounters only. Production deployment needs verified hospital patient-access policy and trusted EMR event authorization.
- Laboratory, imaging, operation and administration sources are unsupported. Missing document text does not establish absence of a document; signed and unsaved editor drafts require separate adapters.
- SQL targets the verified EMR PostgreSQL schema. Other database layouts and a clinical MCP provider need explicit adapters; no fallback changes source meaning.
- Source records are current database snapshots, not historical replay. The package computes no DRG/DIP group, writes no EMR records and sends no insurance report.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
