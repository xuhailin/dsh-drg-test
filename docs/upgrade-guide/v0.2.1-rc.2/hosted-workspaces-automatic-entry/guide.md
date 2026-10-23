---
kind: upgrade-guide
description: "The hosted-workspaces portal root starts SSO with HTTP 303 instead of serving an HTTP 200 sign-in page."
---

# Hosted-workspaces starts company sign-in automatically

English | [中文](guide.zh.md)

## Change

For the hosted-workspaces gateway, unauthenticated `GET /` returns HTTP 303 to company SSO instead of an HTTP 200 page requiring a sign-in click. A live session continues to its own workspace. `GET /?signedout=1` still returns the signed-out page without automatically resuming SSO.

Anonymous personal `/` and `/index.html` requests return through the portal without carrying the old origin as a login target. The newly verified identity selects the personal workspace. Cross-account API authorization and explicit target validation remain enforced.

## Migration

1. Update HTTP checks and browser automation that expect an HTTP 200 portal page or click its sign-in action. Follow the HTTP 303 sign-in flow; use `GET /healthz` for gateway liveness without starting a login.
2. Point user bookmarks at the configured `publicOrigin`. An old personal home bookmark recovers through the portal and opens the currently authenticated account's workspace.
3. Verify automatic entry with a fresh browser session, own-workspace restoration with a live session, and the retained confirmation at `/?signedout=1`. Confirm that another account's API requests remain denied. See the [trial and recovery guide](../../../user/guide/hosted-workspaces.md#verification-and-recovery).
