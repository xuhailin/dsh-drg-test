---
description: "Bind company-authenticated EMR encounters to private Sessions, read authorized evidence, and save advisory pre-discharge findings with exact quotations."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-clinical-review

English | [中文](README.zh.md)

## Summary

Open an authorized inpatient encounter in a private conversation, then request a pre-discharge review without delaying discharge. The model reads bounded original passages and saves findings with verifiable quotations. Refreshing evidence invalidates the current report while retaining its history. Findings always await clinical review; DRG and DIP calculation are explicitly unavailable.

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

Mount this plugin in a company-authenticated private Web runtime with Session persistence, Session Controller, Connection, and the existing model profile. The gateway reader broker owns account and encounter authorization; browser identifiers grant no read access.

### Configuration

The hosted-workspace deployment supplies the broker URL, opaque owner identity, and runtime credential reference. Keep database credentials in the broker and model credentials in the existing model provider. The runtime credential is resolved through Credentials or the process launch environment; no secret belongs in plugin configuration.

| Field | Default | Meaning |
|---|---|---|
| `brokerBaseUrl` | Required | HTTP(S) base for broker `launch`, `consume`, `authorize`, and `capture` requests |
| `runtimeTokenEnv` | Required | Credential/environment name for the private runtime token |
| `ownerId` | Required | Fixed authenticated owner identity supplied by the gateway |
| `cwd` | Required | Private working directory for new encounter Sessions |
| `agentPreset` | Standard default preset | Optional existing preset for newly created encounter Sessions |
| `readerMode` | `http` | `provided` uses a separately mounted `EncounterReader` provider |
| `reviewLanguage` | `zh-CN` | Language requested for report fields and final replies |
| `timeoutMs` | `30000` | Complete broker request deadline, including response body |
| `maxResponseBytes` | `8388608` | Complete broker response limit |
| `maxToolBytes` | `65536` | Complete model-facing text-block array limit |
| `maxSourceChars` | `12000` | Maximum UTF-16 code units per evidence passage |
| `maxInventoryItems` | `20` | Sources per inventory page |
| `maxFindings` | `40` | Findings per report |
| `maxOperations` | `256` | Retained event identities per encounter Session |
| `maxReports` | `50` | Retained historical reports |
| `maxRequestBytes` | `65536` | Complete browser request limit |
| `maxStateBytes` | `33554432` | Complete retained review state limit |

The [configuration schema](src/config.ts) validates deployment bounds. To replace HTTP evidence reads with MCP, mount an implementation of [EncounterReader](../emr-encounter/README.md), then select `readerMode: provided`. Browser launch authorization still uses the broker.

### Entry, review, and refresh

The [EMR entry plugin](../client-emr-entry/README.md) opens an encounter and exposes review controls. The authenticated POST routes under `/api/clinical-review/` accept JSON: `launch` takes a validated EMR launch claim; `review` takes `sessionId`, `eventId`, and `trigger` (`manual-review` or `discharge-order`); `refresh` takes `sessionId` and `eventId`; `status` takes `sessionId`. Responses are not cached. Opening with `trigger: open` binds metadata without fetching clinical text or waking the model.

Review and refresh acknowledge durable admission with `sessionId`, `revision`, `status: accepted | duplicate`, and `dischargeBlocked: false`. Source collection continues asynchronously. Repeating an event ID never starts a second review. A new intended operation needs a new event ID. Review wakes the existing DSH Agent after an authorized snapshot is durable; refresh captures evidence and invalidates the previous report without a model wake. Status exposes progress and active report availability only; saved report text is available through the authorized result API.

One owner/source/hospital/inpatient identity selects one private Session. A Session cannot switch patients. Reopening the same encounter with a changed authorized binding invalidates its old snapshot, read ranges, and report. Forks retain historical text but receive no inherited encounter read authority. Other conversations receive no clinical tools or review instructions.

### Saved results

The browser-safe [`/result` entry](src/result.ts) owns versioned request and response schemas. Authenticated `results` lists saved references for `sessionId`; `result` reads `sessionId`, `resultId`, and the exact accepted-report `revision`. An optional `encounterRef` must match the current binding. Results include original `reportId`, generation and evidence times, exact quotations with retained source metadata, coverage, and separate unavailable DRG/DIP states. Listing can be empty; an unavailable reference returns `result-not-found`. Reads recheck the signed binding and current encounter policy through the broker's authorization-only route, without evidence capture or a model request. Exact encounter grants require no source query; department grants also verify current department membership and fail closed if that verification is unavailable. A later explicit refresh or review capture compares the complete accepted source inventory and coverage, including additions and deletions; results expose `unchanged`, `changed`, or `unknown`, the check time, and `accepted-snapshot` scope. This comparison makes no claim about sources outside the provider's coverage.

The logical `resultId` remains stable within its Session. Revisions count accepted unique reports rather than review attempts; failed or cancelled attempts do not create report revisions. A separate projection recovers each report's original snapshot from complete retained Session records. Old quotations remain unchanged after refresh. Missing retained metadata is null or explicitly unavailable, and legacy findings map only their existing validated classification to the three registered issue codes (`inconsistency`, `missing-information`, `needs-verification`), with no inferred clinical rule, semantic field, or navigation target. Generation time is recovered from the original report record; a history-only legacy report has no inferred generation time.

`rerun` accepts the exact result selection, required `encounterRef`, and `requestId`, then acknowledges asynchronous review admission. Every retry rechecks current authorization. The same request and parameters return its original admission revision without redispatch; changing the selected revision or other parameters under that ID is rejected. Current review progress is independent of the selected report, and failed reviews preserve earlier accepted reports. The API does not navigate or write EMR records.

### Failures and recovery

Each evidence read and report submission reauthorizes and compares the accepted source revision. Changed sources reject stale work. Citation quotes must match previously read UTF-16 ranges exactly; a source can be declared fully reviewed only after its entire content was read. Unsupported, unread, and empty source categories remain distinct. Limits reject complete requests, results, or retained state instead of silently truncating them.

Rejected proposals identify the unread source or the finding and citation indexes without repeating clinical text. Read an incomplete source in full or remove it from `reviewedSourceRefs`; citations to a partial source still require exact passages already read. Unknown source references are identified by their input index without echoing their contents. These diagnostics use the existing logged tool result.

An uncertain Session flush stops dependent review work and reports `durability: unknown`; reconcile persistence before continuing. Resumed incomplete operations become `failed` with `errorCode: interrupted`, without an automatic model wake. Inspect the conversation and submit a new event ID to retry. When the review turn ends without a submitted report, its operation becomes `failed` with `errorCode: report-not-submitted` for an ordinary model stop, or `model-turn-max-tokens` when the output limit is reached; cancelled and failed model turns retain explicit outcomes. Partial reads remain in history, and no automatic followup is issued. Errors and cancellation do not write to EMR or change discharge completion.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The bridge](src/bridge.ts) uses Connection's authenticated fetch registry. [The reader](src/reader.ts) obtains a one-use launch grant, consumes the binding, and verifies bounded evidence responses against the fixed owner. [The coordinator](src/state.ts) serializes each Session's writes, flushes durable admission before asynchronous work, and rejects superseded results. [The state projection](src/projection.ts) rebuilds active review state; the [result projection](src/result-projection.ts) retains immutable report and evidence associations across refresh and restart. [Scoped tools](src/tools.ts) expose only the exact Agent's accepted snapshot and proposal; the standard Session Controller and Agent followup mechanism own model execution.

Disposing the plugin aborts source work, waits for admitted tasks, and removes routes and scoped tools. Binding, snapshots, read ranges, proposals, and event outcomes are stored in the private Session log. No runtime token or database credential is written there.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [EMR encounter](../emr-encounter/README.md) — shared launch, identity, and evidence types.
- [Reader broker](../emr-reader-broker/README.md) — current authorization and data-provider coverage.
- [EMR entry](../client-emr-entry/README.md) — manual entry and trusted-window embedding.
- [Hosted workspaces](../hosted-workspaces/README.md) — company SSO and private Docker runtimes.
- [DRG requirements](../../../docs/requirements/drg-review-assistant-v1.md) — clinical scope and grouping prerequisites.

-----

<a id="model-experience"></a>
## Model Experience

### Encounter review

#### What the model sees

A bound Agent receives inventory, passage-reading, finding-submission, and report-reading tools. An explicit review appends a durable user message requesting evidence-based analysis in `reviewLanguage`. Source metadata includes coverage, cutoff, revisions, and source references; original content appears only in logged tool results. Reports mark every finding `pending-human-review` and both calculations `unavailable`.

#### Token effect

Tool schemas apply only to bound Sessions. Inventory is paginated and passages are bounded, so the model chooses which evidence enters the conversation. Each accepted read and report adds its exact tool output to the Session; repeated reviews retain earlier conversation context and require normal DSH compaction.

#### KV Cache effect

Binding does not rewrite an existing conversation prefix. Review messages and tool results append to the Session; ordinary provider cache reuse depends on the resulting request prefix. The plugin does not maintain a separate model memory or cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This plugin supports advisory review within the current provider's declared coverage.

- It does not calculate DRG groups, DIP scores, reimbursement, confirmed codes, or discharge eligibility, and performs no EMR writeback.
- Freshness currently recaptures the full authorized snapshot for every clinical tool call. The provider can replace this implementation while preserving revision and authorization guarantees.
- There is no automatic retry after interruption or unknown persistence, and no cross-patient selector tool. Retention limits require operator capacity review.
- Saved reports and source text remain private conversation history; reauthorization controls new API and tool reads, not removal of previously displayed messages. Saved-result reads do not recapture evidence or initiate freshness comparisons, and provide no verified EMR navigation mappings.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package-local composition test starts the shipped headless profile with synthetic external evidence and model replies. The [recorded Session](../../../snapshots/session/pre-discharge-review/snapshot.yml) replays real evidence tools and a cited proposal without patient data or a model key. Company SSO, gateway authorization, and database connectivity require deployment integration verification.

</details>
