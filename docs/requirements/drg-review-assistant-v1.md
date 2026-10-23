# Pre-discharge review and DRG/DIP pre-grouping V1

English | [中文](drg-review-assistant-v1.zh.md)

Status: confirmed product direction; first-stage implementation is locally verified and awaiting user acceptance. Pre-discharge review is primary, DRG and DIP compute separately, and review never blocks discharge. Company SSO, private Docker workspaces, and source-only DRG reference sharing are implemented. The first EMR reader, private review Session, and manual browser entry are locally verified; structured human confirmation and both grouping engines remain planned.

Review date: 2026-10-22. Baseline: DSH Web 0.2.1-rc.2 with the current [SSO/private-workspace implementation](sso-private-workspaces-v1.md). Execution sequencing and resource publication belong to the [implementation proposal](drg-review-assistant-v1-implementation.md).

## Summary

Help doctors preparing discharge compare draft diagnoses, procedures, and documents with the available inpatient evidence. Present cited discrepancies and missing information; after human confirmation of the relevant coded snapshot, compute and explain a DRG or DIP pre-group under an explicitly selected scheme.

The first integration uses the existing DSH Web and company SSO with the company model gateway and user-selected gpt-5.5. The user authorized real patient data at this company service and delegated selection of one development encounter from the test department; the pilot pins that encounter to the trial account in an operator-managed allowlist. One encounter belongs to each chat. The report supports doctors, coders, and insurance staff; it does not certify a diagnosis, payer acceptance, or payment amount. Selecting a development database does not authorize every row for model use.

## Table of Contents

- [Users and scope](#scope)
- [Multiple users and shared references](#shared-references)
- [Workflow and example](#workflow)
- [Required records and execution data](#data)
- [Review scope and ownership](#review)
- [Confirmation and result lifecycle](#confirmation)
- [Behavioral requirements](#requirements)
- [Plugin design](#technical)
- [EMR integration and replaceable data access](#integration)
- [Acceptance](#acceptance)
- [Sources and unresolved dependencies](#sources)
- [Dev Note](#dev-note)

<a id="scope"></a>
## Users and scope

Review begins when a doctor prepares discharge, requests a check, or requests review of a generated/edited document. Opening a patient establishes context without starting model analysis. A discharge-order action can trigger asynchronous review, but is neither proof of actual discharge nor sufficient grouping input. Exact EMR events and launch authentication must be verified before activation.

| Subject | Decision or proposal |
| --- | --- |
| Confirmed entry | Pre-discharge clinical-fact review plus pre-grouping; doctors are the primary intended users, with coders and hospital insurance staff as reviewers. |
| Confirmed delivery | Reuse DSH Web, company SSO, the approved company model, and private runtimes; integrate one explicitly permitted development encounter per chat, with corrections and repeated review. |
| Confirmed grouping direction | Preserve the independent complete national DRG-engine goal and add a separate DIP calculation capability. The DIP edition, complete input rules, and validation corpus remain dependencies; two mode prompts are not two engines. |
| Confirmed OpenDRG use | Research its requirements and materials only; do not import its code, engine, datasets, or web bundles, or use agreement with it as acceptance. |
| Confirmed shared storage | Keep national reference materials in persistent server storage, versioned and shared read-only across users and sessions. MinIO is not a first-delivery dependency. |
| Confirmed private workspace | Reuse the existing per-account Docker runtime and private home; reference sharing grants no access to another user's conversations, cases, or files. |
| Proposed narrow review scope | Cross-record consistency, omissions of already documented facts, and explicit diagnosis/procedure reporting rules. National grouping coverage does not imply coverage of every clinical diagnostic criterion. |
| Proposed rule baseline | Official CHS-DRG 3.0, subject to source, dictionary, and precedence verification; a real hospital requires its actual regional edition. |
| Confirmed integration direction | Accept EMR encounter context; use a controlled read-only development-data provider first and replace it with the company MCP provider later. Exact events, identity mapping, permissions, and confirmation transport still require verification. |

V1 excludes autonomous diagnosis, treatment or discharge decisions, comprehensive medication/fee compliance checks, automatic whole-record coding, payment/profit estimates, payer submission, record writeback, unrestricted patient access, OCR, dashboards, batch processing, training, and an autonomous multi-agent coordinator. Review waits, timeouts, failures, missing evidence, and unconfirmed or ungroupable results never veto or delay the EMR discharge transaction.

A successful review identifies the supplied evidence, separates documented facts from unresolved questions, records the user's decisions, and explains a pre-group computed from the exact confirmed input. Payment optimization is not a diagnosis-selection criterion.

DRG and DIP share clinical evidence but retain separate coding snapshots and calculation results. The applicable scheme comes from trusted institutional configuration, including region, effective dates, coding standard, and rule revision. A model cannot choose the more profitable mode. Demonstration comparison must label both schemes explicitly; neither result becomes an official settlement conclusion.

<a id="shared-references"></a>
## Multiple users and shared references

The platform owns the published national reference collection; a conversation owns its case and review state. Shared references are persistent resources, not prior conversations copied into another model context. A new chat can read an installed edition without uploading the national PDF again.

| Data | Owner and access |
| --- | --- |
| Original national publications, compatible dictionaries, reviewed grouping/check resources, and their source passages | Operator-published server collection, readable by all enrolled users; user runtimes and model tools cannot modify published resources. |
| Case packets, execution evidence, drafts, human answers, confirmations, and reports | The authenticated account's private runtime and the exact Session/encounter; another session cannot adopt its evidence or confirmation by supplying an identifier. |
| Regional or hospital customizations | Outside the first shared national collection; future installation requires its own edition, compatibility, and institution-access decisions. |

An unchanged original PDF keeps its file digest even when corrected extraction creates a new derived-data revision. Identify national edition, source-file digests, dictionary editions, derived-data revision, and compatible engine version separately. Preserve original files and published revisions; source corrections and new official editions create new resources instead of replacing old bytes.

At accepted case import, record the selected scheme and pin exact compatible resources that are available. Missing grouping resources are explicitly unavailable and do not prevent independent evidence review. Installing a missing resource later is an explicit new mode revision, never a silent default change. Confirmation and calculation require a complete valid binding; withdrawal invalidates current use while preserving history.

Record every model-visible passage and its resource identity in the Session. Publication or rollback cannot rewrite old explanations. Missing grouping resources stop dependent calculation while independent evidence review may continue with explicit coverage limits; no model-memory or alternate-version fallback is allowed. Historical logs remain readable, with unavailable recomputation stated explicitly.

The gateway selects the private runtime; business tools resolve the current Session from Host/Agent context. SSO does not grant EMR encounter access or reference-publication rights. General DSH tools remain available under their existing policy; patient access stays behind a controlled reader with credentials outside user runtimes. A dedicated preset is optional composition, not the enforcement mechanism for patient authorization. Plugin responsibilities are specified in the [plugin design](drg-review-assistant-v1-plugins.md#plugins).

<a id="workflow"></a>
## Workflow and example

The table describes the intended hospital workflow; document completion, billing, coding, submission, and payer review may overlap. Manual review and verified asynchronous EMR events use the same review service. The first manual browser-entry flow is locally verified; installing actual EMR events, structured human confirmation, and calculation remain separate work.

| Stage | Actor and work | Assistant contribution |
| --- | --- | --- |
| Inpatient treatment | Doctors and nurses document diagnoses, procedures, orders, and execution. | No V1 intervention in care; these records later provide evidence. |
| Preparing discharge | A doctor requests review or performs the configured discharge-order action. | Bind the encounter and obtain timestamped evidence; review available diagnoses/procedures even if the discharge summary is not ready. |
| Document generated or edited | A draft becomes available or the doctor changes it. | Review that exact document revision against source evidence; generation is not acceptance, and a document is not the sole review input. |
| Human review | The doctor resolves clinical questions; a coder or simulated reviewer confirms codes and principal/secondary roles. | Freeze and display the proposed input; record accepted, corrected, deferred, and dismissed findings. |
| Pre-grouping | A reviewer confirms the selected mode and its coded snapshot. | Run the DRG or DIP provider independently; explain paths, missing inputs, or unsupported schemes without conflating their outputs. |
| Before submission | Coders and insurance staff finalize their records. | Recheck a revised snapshot; compare a supplied group only when its edition and input are known. |
| Payer review and settlement | Hospital staff submit data and handle payer feedback. | No claims transaction or settlement operation in V1; a later feedback-review operation needs a separate specification. |

Synthetic example: a 35-year-old man has an appendectomy. The operative note documents perforation and localized peritonitis; the draft discharge diagnosis only says acute appendicitis. This example illustrates record review, not a completed grouping calculation.

1. The user supplies the draft diagnosis, operative note, relevant progress records, orders, execution events, and a cutoff time.
2. The Agent cites the operative passage and asks whether the discharge wording needs confirmation or completion. It does not independently add perforation or peritonitis.
3. A conflicting pathology or progress record remains a question for the doctor; missing evidence remains unknown rather than a negative finding.
4. After human resolution, the user supplies or confirms standard codes, diagnosis/procedure roles, and other required grouping attributes.
5. The system displays the exact snapshot and obtains an explicit confirmation before calculating a pre-group with its rule references.
6. A later amendment creates a new revision and requires review and confirmation again; the old report remains historical and cannot be presented as current.

<a id="data"></a>
## Required records and execution data

V1 accepts an authorized provider packet or a recorded synthetic user-message reference. The reader preserves original source text and execution data; model-authored prose cannot become source evidence. Both entries use the same packet validation. All sources belong to one explicitly permitted encounter; deployment credentials and authorization tokens never enter the packet or model context.

### Minimum packet and conditional records

The minimum packet supports review; grouping additionally requires a confirmed coded snapshot. A missing source prevents the affected check, not necessarily every other check. The report lists unavailable checks and cannot claim that the whole case passed.

| Data | Requiredness and minimum content | Purpose |
| --- | --- | --- |
| Encounter and cutoff | Required: case_ref, encounter_ref, revision, admission time, review cutoff with timezone, supplied age/sex, and draft versus actual discharge information. | Isolate the encounter and exclude facts unavailable at the reviewed time; conditional age-in-days, birth weight, and outcome fields follow the selected rules. |
| Source inventory | Required: supplied record IDs, types, revisions, event and recording times, author role, draft/signed/amended status, digest, and coverage intervals or explicit gaps. | Locate evidence and distinguish missing data from a documented negative; a sender's completeness declaration is not clinical verification. |
| Draft reporting information | Required: current diagnosis list with status and principal/secondary roles, proposed procedure list, and available document revisions. A discharge summary may be absent; codes may initially be unknown. | Identify the review target and mode-specific coding candidates; unavailable documents are gaps, not a reason to reject every review. |
| Admission and progress records | Required: admission/first-course record and diagnosis/treatment-related progress records through the cutoff; provide their inventory and identify omitted or unavailable items. | Compare admission purpose, confirmed/possible/excluded diagnoses, later changes, and current reporting. |
| Order inventory | Required: complete supplied order index through the cutoff, including cancelled, stopped, and replaced orders, with execution-coverage declarations. | Locate potentially relevant care; absence of an order row in a partial export cannot establish absence of treatment. |
| Execution events | Required for any reviewed performed action: actual status, time or interval, performed content, linked order, and evidence source. Explicitly declare none or unavailable where applicable. | Establish what was done, partially done, not done, or remains unknown. |
| Surgery/anesthesia/intervention | Conditional: operative and relevant anesthesia/procedure records, actual procedure name, site/approach when applicable, actual time, completion state, and operator record. | Verify reported surgery/procedure facts; a planned procedure or order alone is insufficient. |
| Special treatment records | Conditional: ventilation, dialysis/CRRT, transfusion, radiation/systemic anticancer treatment, or other treatment invoked by a claim or grouping rule. | Verify actual modality, sessions, duration, and relevant coded facts according to sourced rules. |
| Diagnostic reports | Conditional: the laboratory, imaging, pathology, or consultation reports cited by the reviewed diagnoses, including report time, finality, and relevant units. | Locate supporting or conflicting evidence; one abnormal result does not independently establish a diagnosis. |
| Medication administration | Conditional when a fact review depends on medication: order and actual administration records with drug identity, dose/unit, route, actual time, and execution status. | Distinguish ordering, dispensing, and administration; V1 does not audit every drug's indication, dose, interaction, or reimbursement restriction. |
| Fees and payer feedback | Not required for common evidence review. Amounts are conditionally required if the selected DIP adjustment needs them; retain their source and revision. Payment parameters, costs, reimbursement rates, submission receipts, and payer decisions remain outside V1. | Missing required amounts disable the dependent adjustment; charges never prove actual execution. |

Each record retains a stable source ID and revision plus line/row references and original text or values. Record creation time and the time of the clinical event are separate. A later report describing an earlier event was still unavailable before its recording time; it cannot enter an earlier as-of review without a new revision.

### Execution-event fields and interpretation

The packet keeps order intent and execution evidence separate. Source status mappings must be explicit; unknown enums or units are input errors, not guesses. Raw source values remain available for inspection.

| Object | Required fields when applicable |
| --- | --- |
| Order | order_id, encounter_ref, revision, category, content/code and dictionary identity when available, ordered time, planned interval, stop/cancel time, source status, replacement links, and source_ref. |
| Execution | execution_id, linked order_id or an explicit unlinked explanation, actual event/interval time, executed content, status, dose/unit/route or procedure attributes when relevant, correction/retraction identity, and source_ref. |
| Duration/session evidence | Modality, actual start/end or documented ongoing state at cutoff, interruptions, session identity, and measurement unit; only a verified rule may decide aggregation and rounding. |
| Source mapping | Declared normalization of statuses, units, and identifiers; duplicate-event identity and supersession rules. Retransmitted rows do not create new administrations or treatment hours. |

Cancelled before execution, partially executed then cancelled, and stopped after completed execution are different facts. Cancellation does not erase earlier valid execution. Retraction of a mistakenly recorded execution is a separate source correction. A replaced order neither duplicates nor deletes the linked execution history.

Missing execution evidence means unverified, not unperformed. Planned end times cannot replace actual times. Billing, dispensing, and an order's existence cannot independently establish a completed treatment. If a grouping threshold or coding interpretation lacks a verified rule, request human clarification rather than calculate it from an arbitrary duration heuristic.

<a id="review"></a>
## Review scope and ownership

V1 has three review categories. Each installed check declares its required sources, reporting target, versioned reference, and supported conditions; absent resources make that check unavailable. The catalog defines documentation checks, not universal clinical diagnostic criteria.

| Category | Included behavior | Result that is not allowed |
| --- | --- | --- |
| R1 Cross-record consistency | Compare diagnoses, procedure descriptions, status, negation, timing, and execution across supplied records; show both passages in a conflict. | Resolve contradictory records by model preference, or treat historical/possible/excluded diagnoses as current confirmed disease. |
| R2 Documented-fact omission candidates | Identify a fact already explicitly documented by a clinician or performed-action record but absent from the draft reporting list; ask for review. | Add a diagnosis from an isolated lab abnormality, drug choice, fee item, or a higher-payment opportunity. |
| R3 Reporting and coding questions | Check sourced, explicitly supported principal-diagnosis/procedure reporting conditions and code/name consistency; preserve candidates until human confirmation. | Select principal diagnosis autonomously, certify every diagnosis as clinically valid, or apply an unsourced reporting heuristic. |

The proposed principal-diagnosis reporting target is the insurance settlement list. Its [filling specification](https://www.nhsa.gov.cn/art/2021/8/30/art_140_8508.html) and the [medical-record homepage specification](https://www.nhc.gov.cn/yzygj/c100068/201606/2e3b6393fcff4f0095a45a507a975f2f.shtml) are distinct sources; a rule always identifies its target. Reading a homepage as evidence does not silently change the reporting standard. Full validation of both reporting systems is outside V1.

| Owner | Responsibility |
| --- | --- |
| Agent | Read bounded source passages, propose facts with exact references, identify questions, request clarification, and explain validated findings and grouping results. |
| Deterministic review service | Check case identity, source offsets, source availability, versioning, units/status mappings, snapshot completeness, declared executable reporting checks, and confirmation eligibility. It can validate a quotation without proving the clinical inference. |
| Grouping providers | Validate each mode's confirmed codes and attributes, execute the selected compatible rules, and return DRG paths or DIP disease-match results and explicit non-results. Scores require an identified applicable score table. Providers never infer diagnoses from prose or invoke a model. |
| Human reviewer | Resolve clinical questions, accept/correct/dismiss candidates with reasons, and confirm diagnosis/procedure codes and principal/secondary roles. V1 records an exercise user's confirmation, not a verified physician credential. |

Findings use supported, conflicting, insufficient-evidence, and pending-result states with source links and an explicit proposed action. A supported record statement is not a clinical truth certification; no finding is represented as a formal payer decision. Missing mandatory evidence or unresolved grouping-relevant conflicts prevent confirmation. A dismissed conflict needs a recorded reason and the chosen factual interpretation; it cannot silently disappear.

The report must show review coverage even when no findings exist. Unread sources and unsupported clinical questions remain visible; “no finding in reviewed material” cannot become “the diagnosis and all orders are correct.”

<a id="confirmation"></a>
## Confirmation and result lifecycle

A source packet, a proposed fact set, and a confirmed coded snapshot are separate records. The system preserves the clinician's original draft and the model's proposals without overwriting either. All references bind to the encounter, source revision, and cutoff used by that review.

1. Validate the packet and publish its source inventory and gaps.
2. The Agent reads sources and submits proposed facts and findings; the service validates references and returns a frozen review revision.
3. The user resolves questions that prevent snapshot confirmation and supplies or confirms standard codes. These questions do not block discharge. Choosing “needs correction” creates a new proposal, not confirmation.
4. The service displays the case, revision, cutoff, evidence references, finding dispositions, all grouping fields, and rule/dictionary editions in a confirmation request it constructs itself.
5. An explicit answer to that exact request creates a confirmation receipt bound to the snapshot digest. The grouping service can use it only after the answer and receipt are committed to the Session log. A generic tool permission, model-supplied confirmed flag, pending question, skipped answer, timeout, or natural-language claim that another person agreed is insufficient.
6. The grouping operation accepts the confirmed snapshot identifier, checks that it is current, and computes a result carrying that exact input digest and rule identity.

Changes to shared evidence, cutoff, or human decisions about common clinical facts invalidate both modes' dependent review, confirmations, and results, even if source bytes are unchanged. Only mode-specific coding, findings, or rule revisions invalidate that mode alone. Recheck and reconfirm affected snapshots; presentation-only edits do not create clinical revisions, and historical results remain inspectable.

Serialize accepted encounter revisions and compare the expected revision when accepting a confirmation and publishing a calculation. An update during a human wait invalidates that request; an update during calculation prevents the old result from becoming current. Do not silently overwrite a newer revision or reuse an interrupted uncommitted receipt.

Expose review progress separately from grouping: review can be ready for human confirmation, need evidence/decisions, or be unavailable; grouping can be awaiting confirmation, need input, be unsupported, or complete with a group/ambiguity/ungroupable result. Neither a finished review operation nor a valid input guarantees a group. No single green “passed” state combines clinical review and payer acceptance.

<a id="requirements"></a>
## Behavioral requirements

The identifiers retain their original DRG prefix for traceability; shared requirements also apply to DIP unless explicitly DRG-specific. Review coverage, each engine's completeness, and EMR integration are accepted separately.

| ID | Requirement |
| --- | --- |
| DRG-01 | Import an authorized provider packet or recorded original synthetic message for one encounter; preserve sources, revisions, cutoff, coverage, and unknowns, rejecting mixed encounters or invalid unit/status mappings. |
| DRG-02 | Keep draft, possible, excluded, historical, documented, proposed, and human-confirmed facts distinguishable; do not infer disease from treatment or missingness. |
| DRG-03 | Each material finding cites accessible source rows/passages from the exact packet revision; a conflict cites both sides. An unsupported quotation or future source cannot support a finding. |
| DRG-04 | Interpret order intent separately from actual execution, preserving partial execution, cancellations, retractions, and deduplicated events. |
| DRG-05 | Run only declared R1-R3 checks with available prerequisites; show unavailable checks and grouping-relevant unresolved items. |
| DRG-06 | The user must confirm the frozen coded snapshot through a trusted interaction before grouping. The model cannot create the receipt by asserting approval. |
| DRG-07 | Bind every result to input, evidence, confirmation, rule, dictionary, and review revisions. Material revisions invalidate current confirmations and groups. |
| DRG-08 | Cover every national MDC/ADRG/DRG and required priority, exclusion, special, and non-grouping path in the selected complete pack. Missing national groups cannot be labeled unsupported. |
| DRG-09 | Use only identified compatible rule/dictionary resources; missing required resources prevent pack activation. Unavailable regional customizations return unsupported, without national fallback. |
| DRG-10 | Return a deterministic grouping result with its used fields and references; the model must not rewrite group codes or discard diagnoses/procedures to force a result. |
| DRG-11 | Mark external groups and local pre-groups separately. Input or version mismatch prevents a claim that the payer or local result is wrong. |
| DRG-12 | Persist bounded inputs, exact source evidence, proposals, human replies, confirmations, and results through the Session; reload preserves old identities and current/stale distinctions. |
| DRG-13 | Keep one case_ref and encounter_ref per session. Reject a new encounter in that session and avoid cross-session fact, evidence, or confirmation reuse. |
| DRG-14 | Use native DSH cancellation/errors for runtime failures, do not fabricate success metadata, and require renewed human action after an interrupted unrecorded confirmation. |
| DRG-15 | Source text is untrusted data, not instructions or authority. Development-model integration requires explicit encounter and destination authorization; synthetic fixtures remain the automated-test baseline. The database name alone grants no permission. |
| DRG-16 | Display no payment, profitability, clinical approval, or payer-acceptance conclusion from a successful grouping alone. |
| DRG-17 | Make installed national references readable across users and new sessions without repeated upload; publish them to persistent server storage and expose only read access to user runtimes. |
| DRG-18 | Scope packet references, evidence, drafts, confirmations, and results to the current private runtime and Session/encounter; reject identifiers from another account or session. |
| DRG-19 | Record source digests, derived-data revision, dictionary editions, and engine compatibility; corrected extraction and changed official sources create distinct immutable revisions. |
| DRG-20 | Pin available resource revisions at accepted import and explicitly record unavailable resources; preserve bindings across restart/default changes and require renewed review/confirmation after explicit binding or rebinding. |
| DRG-21 | Keep incomplete/corrupt packs inactive and withdrawn packs unavailable for current grouping; preserve historical reports and never silently replace a missing edition. |
| DRG-22 | Keep resource publication outside model tools and user runtimes; version release/rollback must preserve private homes, accepted Session history, and older published resources. |
| DRG-23 | Select modes from a verified scheme, preserve separate DRG/DIP coded lists and results, and record mode, region, effective edition, dictionaries, and engine identities. |
| DIP-01 | Match a confirmed snapshot against the selected complete DIP rules, including applicable core/comprehensive disease and adjustment paths; preserve matched combinations and rule references. Missing score resources must not become a fabricated score or payment. |
| DIP-02 | Accept DIP completeness against its own versioned inventory and independent positive, negative, and boundary cases. DRG tests or an existing EMR export formula cannot establish DIP correctness. |
| EMR-01 | Establish encounter context without model execution on patient opening; authenticate and deduplicate configured review events before starting asynchronous work. |
| EMR-02 | Authorize every clinical read independently of SSO login; verify source identifier mappings and enforce the designated test-case allowlist. Swapping database/MCP providers preserves these restrictions. |
| EMR-03 | Source refresh, document revision, patient switching, duplicate events, timeouts, cancellation, and provider failures cannot publish another encounter's or an older revision's result as current. |
| EMR-04 | The EMR discharge action completes independently of review, confirmation, or calculation. Failures show a local review status and retry action, never a discharge veto or false success. |

<a id="technical"></a>
## Plugin design

The [plugin design](drg-review-assistant-v1-plugins.md) owns responsibilities, trigger ordering, context fields, tools, mode-specific inputs, confirmation, persistence, failure handling, and replaceable providers. Reuse DSH profiles, scoped tools, skills, and Session history; keep business rules outside the agent loop and SSO gateway. It describes the complete V1 target; the linked package READMEs define the implemented first-stage subset and its current APIs.

Common evidence, coded snapshots, rule resources, and calculated results remain separate. A calculation consumes a confirmed snapshot rather than model-supplied codes; prompt instructions do not implement authorization or grouping. The report keeps clinical findings, calculation status, missing coverage, and reviewer decisions distinct.

<a id="integration"></a>
## EMR integration and replaceable data access

The first adapter accepts EMR encounter claims and verifies the SSO actor against a server-managed encounter allowlist before bounded read-only development queries. The pilot uses the approved company model gateway. Source mapping and coverage are explicit, and browser claims alone do not authorize access. Raw database credentials stay outside private workspaces. No arbitrary SQL or patient selector is a model tool.

The later MCP provider must implement the same encounter-scoped evidence responses, revisions, access checks, and cancellation behavior. The existing [MCP client](../../packages/mcp/mcp-client/README.md) supplies transport, not an existing clinical server or automatic doctor-token delegation. A downstream agent summary cannot replace the original records used by a review.

Standalone DSH uses its root human-interaction channel. Delegated execution returns an awaiting-confirmation request to the trusted caller and accepts only its authenticated human response bound to the exact snapshot. Exercise confirmation is not a clinical credential. Patient switching opens or resumes another authorized Session instead of changing the old Session's encounter.

<a id="acceptance"></a>
## Acceptance

Use synthetic source packets with independent expected findings, human dispositions, codes, and grouping expectations. A domain reviewer must review clinical/reporting expectations before those fixtures can support clinical claims. Source-reference validation is deterministic; a plausible model explanation is not the acceptance oracle.

| ID | Scenario | Observable result |
| --- | --- | --- |
| AC-01 | Operative documentation contains a fact omitted from the draft diagnosis; a paired case contains an explicit conflicting statement. | Cite the relevant passages, ask for human resolution, and add neither diagnosis nor confirmed code automatically. |
| AC-02 | Only a drug order or isolated abnormal test suggests a disease. | Do not create a confirmed diagnosis or move it into grouping input; show insufficient evidence or an unsupported clinical question. |
| AC-03 | An order is cancelled before execution; another is partially executed then stopped. | The first is not treated as performed; the second retains its actual execution. No arbitrary duration threshold is applied. |
| AC-04 | Duplicate synchronization, replacement orders, and a retracted execution occur. | Do not double-count; distinguish execution history from a source correction and keep its references. |
| AC-05 | A required execution source or a pending report is absent; a later final report becomes available. | Show affected checks as unavailable/pending; exclude the later report from the old cutoff and require a new revision for its use. |
| AC-06 | The model rewrites sources, invents a quotation, cites another encounter, or reads embedded approval instructions. | Import only original logged messages or authorized provider responses; reject invalid citations and never interpret source text as authorization or confirmation. |
| AC-07 | Evidence, coding, or a rule revision changes after confirmation, during the confirmation wait, or while grouping runs. | Reject stale acceptance, mark old results historical, and prevent publication as current until review and confirmation are repeated for the new revision. |
| AC-08 | A question is skipped, timed out, cancelled, interrupted, or requested by a runtime-owned child. | No confirmation is fabricated; preserve awaiting-confirmation or native failure, and route a future delegated request to its parent. |
| AC-09 | Confirmed input is complete; a paired case lacks a conditional attribute or a compatible rule pack. | Return a sourced deterministic result for the first; return explicit missing input/unsupported/resource failure for the second, without substitution. |
| AC-10 | Exercise every national group and every required decision/exclusion path. | At least one independently reviewed reachable positive fixture per DRG, with negative/boundary fixtures and no missing national inventory entries; partial coverage cannot pass complete V1. |
| AC-11 | An external group uses another version or input; the current case is corrected. | Explain non-comparability, retain both identities, and preserve old and new snapshots instead of asserting payer error. |
| AC-12 | Reload a session after a pack update; run two encounters in separate sessions; request a new encounter in the first. | Restore original evidence and stale/current state, preserve isolation, and reject the encounter switch. |
| AC-13 | Cancel calculation or lose the model/provider. | Native error/cancellation is visible; no new successful group or success metadata is fabricated. |
| AC-14 | Call the same confirmed business operation outside DSH, and inspect the final model explanation. | Match deterministic grouping results; every material explanation has a valid evidence/rule reference and adds no payment or clinical-approval claim. |
| AC-15 | Two SSO accounts and several fresh sessions query the same installed national edition. | Read the same identified resources without re-upload; their cases, files, evidence, and confirmations remain private, including forged cross-account/session identifiers. |
| AC-16 | A user's file/command tools attempt to alter or replace the shared collection; recreate its container and restart the gateway. | Writes fail, other users' reference hashes stay unchanged, and the persistent collection plus private case/resource bindings survive. |
| AC-17 | Publish or roll back a default while a case is waiting for confirmation or calculating; explicitly rebind that case later. | The original case keeps its pinned revision, new imports use the selected default, and rebinding makes prior confirmation/results stale until re-review and confirmation. |
| AC-18 | Publication stops midway; a checksum/dictionary/engine mismatch is found; a revision is missing or withdrawn. | No incomplete pack becomes active or supplies a current group; show the specific resource failure/status, preserve historical content, and never fall back to another edition. |
| AC-19 | Restore the collection and private homes from backup, then reload a historical case. | Restore original identities and logged evidence, verify exact resource digests before recomputation, and report missing revisions instead of using current defaults. |
| AC-20 | Apply both modes to the same evidence; correct mode-only coding, then change a common factual interpretation without editing source bytes. | Mode-only corrections invalidate that mode; shared factual decisions invalidate both. Independent DRG/DIP payloads and confirmations remain distinct. |
| AC-21 | DIP resources are complete, or disease rules/score tables/engine versions are missing. | Independent DIP fixtures validate matching and supported scoring; missing resources remain explicit, with no DRG substitution or invented payment. |
| AC-22 | Open a patient, trigger review twice, switch patients, and revise a document during a run. | Opening alone makes no model request; duplicate events do not duplicate reviews; late results retain their original encounter/revision and never become current on the new one. |
| AC-23 | The model, database, MCP, or grouper fails or confirmation is never answered during discharge. | The original EMR discharge operation still completes; review displays failure, missing coverage, or waiting status without a false pass. |
| AC-24 | A valid SSO account submits a foreign encounter, mismatched identifiers, or a non-allowlisted development case. | Read is denied before patient content reaches the model; the same denial holds for database and MCP providers. |
| AC-25 | No discharge summary exists, or a generation event precedes readable content and an older draft is returned. | Review available evidence with explicit gaps; never substitute the old draft. A newly readable revision triggers fresh review, duplicate events are deduplicated, and discharge remains independent. |
| AC-26 | A human corrects coding/roles or confirmation persistence fails; then retry or restart occurs. | Corrections produce a new unconfirmed snapshot; only fresh acceptance can permit calculation. Unacknowledged persistence remains unknown and is reconciled by operation ID, never treated as successful confirmation or automatic rollback. |

The fixed review corpus requires valid citations for every material finding, no automatic diagnosis/coding confirmation, and correct handling of every confirmation/calculation precondition. Record misses and false positives separately; synthetic tests do not establish clinical sensitivity, specificity, or hospital agreement. Review and complete grouping coverage are reported separately.

Implementation validation includes focused domain/adapter tests, keyless recorded-session snapshots, and a real DSH Web flow covering packet submission, questions, human confirmation, grouping, revision, and failure. Documentation validation alone is not feature acceptance. After implementation, provide the tested version and evidence for the user to accept the normal, conflicting, missing-execution, stale-confirmation, and unsupported-version scenarios.

<a id="sources"></a>
## Sources and unresolved dependencies

The sources below establish the national/reference context; they do not establish hospital connectivity, clinical certification, or a complete executable engine.

| Source | Use and limitation |
| --- | --- |
| [Official CHS-DRG 3.0 release](https://www.nhsa.gov.cn/art/2026/9/2/art_104_21975.html) and [DRG attachment](https://www.nhsa.gov.cn/module/download/downfile.jsp?classid=0&filename=a7d842bb9ca046868a17a5611f026086.pdf) | Independently maintained national grouping basis; not proof of a hospital's actual local version. |
| [Medical-record homepage specification](https://www.nhc.gov.cn/yzygj/c100068/201606/2e3b6393fcff4f0095a45a507a975f2f.shtml) | Requires traceable diagnosis evidence and identifies clinical/coding responsibilities; its reporting rules are not automatically settlement-list rules. |
| [Settlement-list specification](https://www.nhsa.gov.cn/art/2021/8/30/art_140_8508.html) | Reporting reference for the proposed principal-diagnosis checks; pin the exact attachment before encoding any check. |
| [Hospital DRG-management practice](https://www.nhsa.gov.cn/art/2025/2/12/art_206_15678.html) | Describes pre-grouping and doctor/coder/insurance-staff review; a case study, not a universal national workflow mandate. |
| [Intelligent-review policy explanation](https://www.nhsa.gov.cn/art/2023/9/13/art_105_11261.html) | Distinguishes detected medical-reasonableness questions from final payment decisions after review and appeal. |
| [National coding maintenance platform](https://code.nhsa.gov.cn/) | Obtain and identify compatible diagnosis/procedure dictionaries; grouping and dictionary version numbers are distinct. |

The DRG PDF retrieved on 2026-10-21 has 1,826 physical pages, SHA-256 `82b5d179d797e2b9586b337d628c20177c85f43738529159c906fd0ef8432e41`. Printed body pages are 18 lower than physical pages. Inventory starts at printed 1/2/14, ADRG rules at 34, codes not used for grouping at 1309/1335, special rules at 1360, MCC/CC lists at 1370/1407, and exclusions at 1555. Two-column and cross-page tables require layout-aware extraction and human review; plain text extraction is not a verified pack.

The following decisions/dependencies remain for implementation review. Server-persistent, versioned read-only sharing is confirmed; MinIO, shared patient storage, and hospital deployment are not prerequisites for the local prototype.

1. Review catalog and domain verification: approve the concrete R1-R3 checks, settlement-list target, synthetic gold cases, and clinical/coding review owner. A full clinical-diagnosis checker is not implied. No reviewer or clinical gold set is currently assigned.
2. Complete grouping resources: identify exact dictionary releases/mappings, global precedence and exceptional rules, and an independent grouping benchmark. These have not all been obtained; missing resources block complete-engine readiness, not permission to substitute OpenDRG or model guesses. Confirm national 3.0 as the prototype pack after resource verification; actual local deployment needs separate edition selection.
3. Data and company integration: maintain the approved development encounter allowlist, validate source identifier/status mappings, and integrate the launch and data-access protocol. Database-to-MCP replacement preserves evidence coverage and authorization; unavailable execution sources remain explicit gaps.
4. Composition and operations: review the proposed plugin/tool composition, assign clinical/coding reviewers and resource publishers, and establish DIP edition/score resources and independent benchmarks. Exact EMR event wiring remains an integration dependency. Server and backup destinations are deployment decisions, not blockers for this design.

The [implementation proposal](drg-review-assistant-v1-implementation.md#sequence) separates shared-source infrastructure, evidence-review integration, and independent DRG/DIP engines. Source archives and sharing are implemented, while the first-stage manual evidence-review flow is locally verified and awaiting user acceptance. That stage does not establish complete-engine or clinical deployment acceptance.

<a id="dev-note"></a>
## Dev Note

On 2026-10-22 the user confirmed pre-discharge review as primary, separate DRG/DIP pre-grouping, and non-blocking discharge. The user subsequently selected company gpt-5.5, authorized real data at that destination, and delegated selection of one development test-department encounter. The pilot implements encounter access and advisory review; complete grouping and clinical acceptance remain separate. Existing source-sharing evidence remains in the [implementation record](drg-review-assistant-v1-implementation.md#dev-note).
