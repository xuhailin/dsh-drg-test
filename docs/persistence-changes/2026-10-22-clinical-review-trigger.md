---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-clinical-review-trigger

English | [中文](2026-10-22-clinical-review-trigger.zh.md)

## Summary

Adds the clinical-review-trigger message source with event ID and review revision to the existing user-message, developer-message, inbox-splice, and title-request persistence types.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-clinical-review-trigger
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "79d675f8e1e3264ba3de4a10beaae93f69a525c72272eefe15527adfe10d0f90"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "522f01da29864a4599e5ad30275d2b62c9fc8b2d468f5036afc7ce9db0a15b65"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "307bd29eb8223ada5f930ae24fbf5050e7cfd340a1ba837bcbbdf4f0960f5f7e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "a7bce308e9f7f0343898e2f95bddbd8ef2e3db4694f81e183ecad3f399eabf5f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The writer remains Session format V4. New readers retain every existing message source unchanged; a Session without clinical plugin records has no clinical binding or inferred access. Existing V4 readers accept any nonempty direct source kind except the retired plugin wrapper, so clinical-review-trigger and its metadata survive decoding in all four affected message slots. The conversation renderer treats non-user sources as context or triggers, and title consumers require the exact user kind; the new source does not become an ordinary human message or grant patient access. This guarantees preservation and ordinary rendering of recorded messages, not execution of clinical tools by older installations.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts passed 10 tests, including unknown direct source kinds and nested metadata through V3 migration and native V4 restoration. A focused local V4 codec check encoded and strictly decoded clinical-review-trigger in all four affected message slots and retained kind, eventId, and revision exactly. The clinical-review focused suite passed 20 tests.

<a id="dev-note"></a>
## Dev Note

None.
