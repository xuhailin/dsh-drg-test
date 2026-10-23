---
description: "Read authorized encounter evidence through replaceable providers with explicit source versions and coverage."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-emr-encounter

English | [中文](README.zh.md)

## Summary

Read one authorized encounter as immutable original evidence, with source identities, content digests and explicit coverage. Providers can change without changing the review tools. Consumers keep each binding within its owning account and Session; parsing an identifier does not grant patient access.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount one concrete reader provider, such as [the controlled PostgreSQL broker](../emr-reader-broker/README.md), and consume `ctx.encounterReader`. The abstract service has no standalone mount configuration. Runtime consumers validate wire responses with the exported parsers before retaining evidence. Browser consumers import the same parsers from `@deepseek-ai/dsh-experimental-emr-encounter/wire`, which does not load the Cordis service.

The browser-safe entry also exports [directory schemas](src/directory.ts) for authorized department labels and bounded inpatient pages. Requests carry no account identity; patient rows include only encounter identifiers, name and bed. Parsing these records grants no access.

Bindings retain the verified account, issuer, subject, hospital and admission identifiers. Sources retain original content and source state; coverage distinguishes complete, empty, unread and unsupported categories. Empty means the supported query returned no records, not absence of disease or treatment.

Providers reauthorize each capture, honor cancellation and reject incomplete or oversized snapshots explicitly. Consumers own Session binding, durable evidence, citations and stale-result handling; provider responses do not themselves change a Session or wake an agent.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [service definition](src/index.ts) separates authorization-aware capture from transport and database implementations. [Wire schemas](src/schema.ts) reject extra launch fields, invalid identifier encodings, duplicate source references and incomplete category coverage. [Record types](src/types.ts) preserve opaque IDs independently from source-system admission numbers.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Clinical plugin design](../../../docs/requirements/drg-review-assistant-v1-plugins.md) — review ownership and provider replacement.
- [Reader broker](../emr-reader-broker/README.md) — controlled development PostgreSQL reads.
- [Architecture](../../../docs/architecture.md) — provider and consumer composition.

<a id="model-experience"></a>
## Model Experience

None, as this service definition registers no model tools, prompts or Session content.

#### KV Cache effect

No direct effect; review consumers own model-visible evidence and its logging.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This experimental exchange format has no production patient-access policy or clinical grouping engine.
- MCP transport is not implemented here. A future provider must preserve authorization, versions, source content and coverage.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
