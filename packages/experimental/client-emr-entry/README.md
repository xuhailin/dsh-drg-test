---
description: "Embed authenticated encounter entry and optional pre-discharge review in the Web workspace."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-emr-entry

English | [中文](README.zh.md)

## Summary

This optional Web plugin opens a private encounter Session from an EMR window or an identifier-only form. Users start pre-discharge review and refresh evidence through the existing conversation header. Clinical evidence and findings stay in the Session; review never blocks discharge.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Add this package to a Web profile alongside [clinical-review](../clinical-review/README.md). Its Host export serves public settings through the owner-authenticated Connection route; its Client export registers a sidebar entry action, conversation-header review action, and shared modal/toast overlay. Launch the application through the `dsh` Web profile with the deployment overlay.

```yaml
- name: '@deepseek-ai/dsh-experimental-client-emr-entry'
  config:
    allowedOrigins: ['https://emr.example']
    defaultSourceSystem: emr
    defaultHospitalCode: test-hospital
    requestTimeoutMs: 30000
    maxPendingRequests: 4
    maxMessageBytes: 8192
```

`allowedOrigins` defaults to an empty list, which disables window messages while retaining the form. Entries must be exact HTTP(S) origins without credentials, paths, or trailing slashes. The two defaults are required form values; they do not grant encounter access. `requestTimeoutMs` bounds operation waits, `maxPendingRequests` bounds concurrent requests, and `maxMessageBytes` bounds each accepted message. The reader broker reauthorizes the account, hospital, and encounter independently.

Browser configuration and action requests resolve `api/...` relative to the current workspace document, preserving hosted workspace path prefixes.

### Open and review an encounter

**Connect encounter** appears in the sidebar while viewing a `clinical-review` Session, including a new one, or the clinical patient panel. **Pre-discharge review** appears only on a Session whose recorded preset is `clinical-review`. Other presets and unknown Session summaries show neither conversation entry. These display rules grant no access; server authorization is unchanged, and authenticated external EMR launches remain available regardless of the selected preset.

Use **Connect encounter** to enter the source system, hospital code, inpatient record ID, and optional admission number. Opening a Session binds identifiers without reading clinical text or calling a model. In that Session, **Pre-discharge review → Start review** captures evidence and starts analysis. **Refresh evidence** captures a new snapshot without starting analysis; review again to replace the previous findings. Results appear through the existing chat tools. DRG/DIP grouping remains unavailable until a calculation provider is configured.

Opening the review controls reads the current Session's progress and revision. **Update status** repeats only that metadata query; it does not capture evidence or call the model. The panel distinguishes a generated report awaiting human review, a model stop without a submitted report, an output-limit failure, unavailable status, and denied access. An unbound clinical-review chat shows that no encounter is connected. Failed status queries retain the last retrieved metadata with an explicit label. Closing the controls, switching Sessions, or unloading the plugin prevents old responses from replacing the current view.

Failed or uncertain operations retain the form and show a shared notice. Inspect the Session before retrying an uncertain request. Local cancellation stops waiting; it does not undo server-admitted work or affect discharge.

### Embed an EMR entry

The [static browser example](examples/emr-entry.html) can be served by an existing EMR development server. Add that server's exact origin to `allowedOrigins`. Sign in to the workspace first and enter its personal workspace URL in the example. The embedding page must retain its popup or iframe window reference; do not use `noopener` for this integration.

The workspace sends `{ type: 'dsh.emr.ready' }` only to its opening window or parent at configured origins. After verifying both `event.source` and the expected personal workspace origin, the EMR sends `{ type: 'dsh.emr.launch', value: claim }` to that exact origin. The claim contains `eventId`, `trigger`, `sourceSystem`, `hospitalCode`, `inpatId`, and optional `inpatCode`, `sourceVisitId`, `documentId`, and `documentRevision`. Use `trigger: 'open'` for patient navigation; `manual-review` and `discharge-order` explicitly request review admission. No clinical body is accepted.

A reply has `type: 'dsh.emr.launch.result'`, the original `eventId`, `dischargeBlocked: false`, and either `status: 'failed'` or a successful `status` plus `sessionId`. It carries no patient details or report. Pending duplicate event IDs with identical content share one request; the server owns durable event deduplication. New intended operations need new event IDs. The example bounds its handshake wait and never gates discharge on an acknowledgement.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) owns public configuration and its authenticated route. [`src/client/index.ts`](src/client/index.ts) owns locale/slot registrations and trusted-window dispatch. [`actions.ts`](src/client/actions.ts) owns bounded same-origin browser requests, cancellation, and navigation through `uiWorkspace.openSession`; only the most recently requested operation may change the selected Session. [`protocol.ts`](src/client/protocol.ts) validates incoming messages and metadata responses. [`Entry.tsx`](src/client/Entry.tsx) reuses the shared modal, inputs, buttons, and toast. Disposing the plugin removes listeners and registrations, aborts pending browser requests, and waits for their settlement.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Clinical review](../clinical-review/README.md) — Session binding, evidence capture, review admission, and report lifetime.
- [EMR encounter](../emr-encounter/README.md) — identifier and evidence types.
- [Hosted workspaces](../hosted-workspaces/README.md) — company SSO and private runtime isolation.

<a id="model-experience"></a>
## Model Experience

Indirectly, through clinical-review, which turns explicit review actions into logged evidence and review requests; opening an encounter or refreshing evidence makes no model call.

#### KV Cache effect

None directly; the clinical-review Session events determine later request content and cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Window integration requires an already authenticated personal workspace and a retained opener or parent. First-login redirects that change the workspace origin or remove its opener need a new handshake after login; no launch context is stored in URL fragments or browser persistence. The manual entry form remains available in the clinical-review contexts above.
- Progress is read on opening the controls or choosing **Update status**; no automatic polling is performed. Report content stays in chat, and this package does not configure DRG/DIP calculation engines.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Host and Client compile through separate leaf configurations. Package-local tests exercise the authenticated route through Loader configuration, trusted-window dispatch, request cancellation, and localized form output without using patient data or a model key.

</details>
