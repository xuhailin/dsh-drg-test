---
description: "Read authorized saved clinical reports from chat cards, the Sidebar, or an independent Web page."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-clinical-results

English | [中文](README.zh.md)

## Summary

This optional Web plugin presents the Insurance assistant's review summary, items for clinician confirmation, original record quotations, and record coverage. Chat cards open the report revision accepted during their Turn. The existing right Sidebar and `?page=clinical-results` page share one renderer; opening either makes no model request and does not capture evidence. Review guidance never blocks discharge.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Load this package and [clinical-review](../clinical-review/README.md) in a supported Web profile. `allowedOrigins` accepts exact HTTP(S) origins for an opening EMR window. `requestTimeoutMs` bounds authenticated reads and admission requests; `maxMessageBytes`, `maxPendingRequests`, and `maxActionReceipts` bound embedding messages and retained receipts. `directoryPageSize` limits each patient-directory page. Public settings contain neither credentials nor patient content.

Open a saved report from its chat card, or open `?page=clinical-results&sessionId=<reference>&resultId=<reference>&revision=<number>`. Resolve the query against the workspace root document, preserving any reverse-proxy path prefix. A Session-only link lists authorized saved reports and requires an explicit selection. References do not grant access: every read checks the authenticated owner and encounter permission. A report always retains its source quotations and evidence revision; current sources are never substituted into historical citations.

The summary and items for clinician confirmation appear first. Each item shows the reason, the original wording, and what to check. Source identifiers, revisions, quotation offsets, retrieval diagnostics, original classifications, and report history stay in expandable details. Record coverage distinguishes obtained, not obtained, not connected, and no records returned: obtaining data does not establish that it was fully reviewed, and missing data does not establish that the patient has no related condition. The viewer states that DRG/DIP grouping is not connected and provides no grouping or reimbursement conclusion.

Medical record update status reports only a comparison supported by an explicit accepted capture; the comparison time and scope remain in report details. Unknown freshness is readable. A zero-item report does not establish complete coverage or clinical clearance. Clinical-review conversations receive localized welcome and composer text through the Conversation presentation registry. An existing clinical Session with a configured working directory uses managed workspace selection, so clinicians can ask about the record without choosing a directory or preset. Model availability and input restrictions still apply; standard conversations retain their own presentation.

**Request another review** admits an explicit idempotent request. Admission, analysis progress, and report selection remain separate. Update progress and choose a new saved revision when it becomes available. Failed reads retain a previously displayed report with a notice; authentication or permission loss clears clinical content. An uncertain admission requires inspecting progress and the chat before another request.

### Embed a result

Open the workspace root document with `?page=clinical-results` inside the authorized EMR parent or opener and configure its exact origin. Each load announces a new protocol-versioned view challenge. The opening window must verify the workspace origin and retain its window reference. The protocol carries selection references and correlated action receipts; report bodies are read through authenticated HTTP and never sent through window messages. Switching patients or accounts clears the view and invalidates pending correlations. A direct page reauthorizes the same explicit report revision after reconnecting. An embedded page clears clinical content and requires a fresh handshake after reconnecting or reloading.

The protocol supports opening saved reports and requesting a review. EMR record, field, and section navigation remain disabled until an adapter supplies verified mappings and encounter checks. No arbitrary URL, SQL, script, or DOM selector is executable. Completing a navigation or review request does not assert that clinical text was saved or a finding was resolved.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry validates public settings and registers an authenticated configuration endpoint. The browser entry registers the standalone page and optionally contributes Turn-tail cards and an existing Sidebar tab type. Each `ResultController` owns bounded requests, selected report identity, and an observable snapshot; no global current-patient state exists. The shared `ResultView` displays typed saved-result responses rather than parsing Markdown. Disposing the plugin removes routes, slots, dictionaries, and listeners, aborts requests, and clears retained view content.

</details>

## Further Exploration

- [Clinical review](../clinical-review/README.md) — saved result projection, authorization, and explicit review admission.
- [EMR encounter](../emr-encounter/README.md) — encounter identity and immutable evidence.
- [Viewer requirements](../../../docs/requirements/clinical-result-viewer-v1.md) — result and action acceptance scenarios.

## Model Experience

Indirectly, through clinical-review, when the user explicitly requests another review.

#### KV Cache effect

None for viewing. Explicit reruns follow clinical-review's request and evidence behavior.

## Known Limitations and Deferred Work

- Real EMR SSO, Cookie policy, iframe policy, and reverse-proxy origins require browser acceptance in the configured environment. An iframe that cannot authenticate must use the configured top-level SSO flow and reconnect afterward.
- EMR navigation mappings and calculation engines are not configured by this package. Legacy findings retain their original classification and have no verified semantic field target.
- Progress updates are explicit reads, not live synchronization. Freshness comparison is limited to the complete accepted evidence catalog and its declared coverage.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Host and Client use separate compiler faces. Browser integration boots the shipped Web profile with synthetic external authorization, evidence, directory, and model providers; the clinical service, saved-result API, persistence, and UI remain real. Card confirmation reads the exact saved revision after report persistence settles, and failed confirmation never publishes a saved-result card.

</details>
