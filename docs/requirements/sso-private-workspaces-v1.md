# SSO and private DSH workspaces V1

English | [中文](sso-private-workspaces-v1.zh.md)

Status: Docker implementation and local verification are in progress. Company server deployment and independent user acceptance remain pending.

## Summary

Provide one company SSO entry to the existing DSH Web application, with private conversations, files, terminals, and tool interactions for each account. The immediate delivery is Docker code, local validation with mock identity/model services, and the company SSO registration checklist. The initial real model provider is DeepSeek; sub2api and the separate DRG prototype are deferred.

## Table of Contents

- [Confirmed scope](#confirmed-scope)
- [Current implementation](#current-implementation)
- [Architecture](#architecture)
- [Identity and private data](#identity-and-private-data)
- [Execution and credentials](#execution-and-credentials)
- [Acceptance](#acceptance)
- [Dependencies and verification](#dependencies-and-verification)
- [Dev Note](#dev-note)

<a id="confirmed-scope"></a>
## Confirmed scope

The user selected company stable SSO, multiple users with private conversations, preservation of DSH tool capabilities, and an internal Linux deployment. The user then authorized the Docker implementation and local verification before choosing a server or domain. The first delivery does not depend on registering a real SSO application; a local mock provider exercises the login flow.

Each user needs a private workspace, execution permissions, and tool interactions. This scope includes the existing chat interface and its supported shell, file, terminal, approval, and subagent flows. Availability of platform-specific or external tools depends on the deployed image and integrations; retaining tools does not establish that every desktop capability works on Linux.

The user selected server-side persistent private volumes for the first delivery. Moving conversations into the EMR PostgreSQL database or adding OceanBase is outside this delivery. Acceptance must verify retained history after restart, the same history after a fresh login from another browser, and denied cross-account access. The user approved the private GitLab project [xu.hailin/dsh-drg-test](http://git.sy/xu.hailin/dsh-drg-test) for CI and publication. CI builds images without uploading them, as selected by the user after an unauthenticated upload-start probe succeeded against the company registry and was cancelled. Server and company-domain selection remain deferred.

The trial does not connect real patient records, implement DRG rules, change emr-app, or provide public anonymous code execution. Sharing workspaces or conversations between users is outside the first scope.

<a id="current-implementation"></a>
## Current implementation

The optional [hosted-workspaces bundle](../../packages/experimental/hosted-workspaces/README.md) implements OIDC login, durable accounts and browser sessions, personal Docker runtime provisioning, authenticated HTTP/WebSocket routing, and restricted shared-key model access. The [Docker trial guide](../user/guide/hosted-workspaces.md) owns local commands and the exact SSO registration checklist.

Each personal container uses the existing Web profile and its [owner Peer](../../packages/client/connection/src/rpc-host.ts). That owner controls only one account's runtime. Separate home volumes and Docker execution environments provide user separation; conversation permissions or different working directories alone do not provide that isolation.

The repository supplies a Docker image, dedicated gateway profile, and local Compose overlay with mock OIDC and model services. These artifacts enable local execution without a company server or API key. Their presence does not establish that the complete Docker/browser/tool flow or company deployment has passed acceptance.

<a id="architecture"></a>
## Architecture

The implementation uses a common SSO gateway and one personal DSH container per account. A container serves that account's conversations and browser sessions. Logout retains the container, private volume, and background work; automatic idle stopping is not implemented.

| Component | Responsibility |
| --- | --- |
| SSO gateway | Authenticate through its own registered OIDC client, maintain browser sessions, and select only the authenticated user's runtime for HTTP and WebSocket traffic. |
| Runtime manager | Map stable authenticated identities to private containers and volumes, validate or start runtimes, and apply container limits. Its Docker control access is unavailable to user containers. |
| User DSH runtime | Launch the existing Web profile with private home, agent configuration, workspace, processes, and tool interactions. The local owner is confined to this user's container. |
| Model gateway | Hold the upstream DeepSeek Key outside user containers, validate restricted runtime credentials, and enforce allowed models, request paths, and per-user usage limits. |

All DSH applications launch through named profiles. The repository image starts the profile-loaded gateway plugin with `gateway` and personal runtimes with `web`. The implementation adds no package executable and does not alter the agent loop.

<a id="identity-and-private-data"></a>
## Identity and private data

Use the verified issuer and subject to resolve an internal user identity. A display name, employee number supplied by the browser, URL parameter, or forwarded client header cannot select another user's runtime. Repeated logins for the same identity recover the same private data; identical subject values from different issuers remain distinct.

The gateway owns the identity-to-runtime mapping and browser-session records. Each runtime owns its DSH_HOME, DSH_AGENTS_HOME, conversations, attachments, settings, installed user plugins, workspace, and terminal state. The runtime manager owns volume allocation and container lifecycle; private volumes are not mounted into other users' containers.

The same authorization applies to index responses, API calls, uploads, downloads, exported logs, previews, and WebSocket upgrades. Personal runtime ports are not published to the host. The gateway uses a bare portal origin and per-account subdomains; a company reverse proxy must preserve Host and support upgrades, as described in the [deployment guide](../user/guide/hosted-workspaces.md#company-services).

Browser storage and served active content use separate per-account origins, including when accounts use the same browser. The gateway verifies that the authenticated identity owns the requested origin. SSO cookies and upstream login tokens are not forwarded into personal DSH containers.

Logout and expiry invalidate the affected browser session and close its established streams. They do not delete private files or authorize another identity. The current application-local logout retains background tools and the provider's global SSO session; it does not implement provider logout or task cancellation.

<a id="execution-and-credentials"></a>
## Execution and credentials

Each personal container receives its own persistent home volume and the application image. It runs without host PID or network namespaces, privileged mode, the Docker socket, host-root mounts, or control-plane credentials. Docker configuration enforces memory, CPU, PID, and temporary-storage limits. Deployment acceptance must verify that network/firewall settings block other user runtimes and the host control plane while allowing configured integrations and the model gateway.

Persistent home volumes have no per-account hard disk quota in this implementation. Shared Linux deployment requires an enforced filesystem/project quota or another verified storage limit, plus disk-full recovery and backup procedures. Volume separation does not supply a disk quota.

Preserve DSH's existing per-call sandbox and approval behavior inside the container. Container isolation provides separation between users; a different working directory or DSH sandbox mode is not its substitute. Approval requests, answers, terminal streams, and child agents stay within the owning runtime.

The real DeepSeek Key must not enter personal-container environment variables, credential files, logs, images, or mounts. Users retaining shell and file tools can inspect their own runtime. A personal runtime receives only its own restricted model-gateway credential; extracting it must not grant another user's data, quota, or management operations. The shared-key proxy accepts only streaming Messages requests and rejects Files operations and upstream file references; image inline fallback still needs end-to-end validation.

<a id="acceptance"></a>
## Acceptance

The first delivery validates the local Docker composition with synthetic data and mock external identity/model services while exercising the actual DSH runtime and tools. Company SSO and real DeepSeek validation remain a later acceptance stage, after registration and the company entry are available. Both stages retain the following isolation and failure requirements.

| Scenario | Required observable result |
| --- | --- |
| Users A and B log in concurrently. | Each sees only their own history, workspaces, settings, downloads, and live tool output; direct requests for the other's resources are denied. |
| A uses file and shell tools with absolute paths, traversal, symlinks, and network requests. | B's volumes, runtime, process data, and the host control plane remain inaccessible. A can still read and modify permitted files in A's environment. |
| Both users have pending approvals, questions, terminals, or subagents. | Each interaction reaches only its owner; replaying the other user's interaction identifier does not approve or control it. |
| A logs out, switches accounts, or lets a session expire while a WebSocket is open. | The affected connection loses access; cached UI does not expose A's data to the next account. B's independent session stays available. |
| A container or the server restarts. | The identity mapping and private conversations/files recover from their owned volumes; another identity cannot claim them. |
| A inspects environment variables, credential files, or model errors. | The upstream DeepSeek Key is absent; only A's restricted proxy credential may be visible. Limits remain enforceable outside A's runtime. |
| A logs out while a background tool is active. | Browser access is revoked, the tool remains confined to A's runtime, and the UI states that background work and files are retained. |
| SSO, container startup, model requests, or resource allocation fail. | The affected operation reports its failure without routing to another runtime, claiming success, or deleting private data. |

Local acceptance requires two mock identities, streamed chat through the real DSH runtime, a real file/shell tool result, and observed isolation, persistence, logout, and failure outcomes. Unit checks and container startup alone do not satisfy that stage. Company acceptance additionally requires real SSO and a real streamed DeepSeek conversation through the intended entry; both stages require independent user acceptance.

<a id="dependencies-and-verification"></a>
## Dependencies and verification

Docker is the current implementation target; Kubernetes is outside this delivery. The exact Linux host, company entry domain/TLS, network/firewall controls, persistent storage quotas, and operational recovery remain deferred. None of those choices blocks the local mock composition.

Company integration needs a separate confidential Web client with authorization-code flow, S256 PKCE, `client_secret_basic`, `openid profile`, and an exact portal `/auth/callback`; no callback registration is required for personal subdomains. The gateway does not call provider logout. The [registration checklist](../user/guide/hosted-workspaces.md#sso-registration) owns the complete administrator-facing settings. Real client registration, secret provisioning, and company deployment have not been performed.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working verification context — click to expand</summary>

Local verification used Docker 29.5.2 on Linux arm64 through Colima, Node 24.21.0 in the image, and synthetic Alice/Bob identities. This record covers the workspace changes on `codex/sso-private-workspaces`; exact revision details are retained in local verification evidence.

The package has 209 passing tests across nine files, with 100% statement, branch, function, and line coverage. Host builds, aggregate checks, scoped lint, package constraints, shell syntax, Compose configuration, and the existing keyless Bash session snapshot passed. `pnpm run test:docs` passed 20 of 21 gates; the unchanged `python/sdk/uv.lock:113` commit reference fails the repository-reference gate.

The Docker smoke exercises real Web profiles and Bash, streamed mock-model responses, separate account origins/history/volumes/networks, rejected foreign cookies and session IDs, default workspace permissions, peer-network denial, runtime and gateway restart, model access after restart, fresh-login history recovery, and logout revocation without disconnecting Bob. Browser verification confirms automatic SSO navigation, approval reaching only Alice and creating her marker only after she allows it, working logout, fresh-login restoration, an unobstructed account row, and zero Bob console errors or warnings. The final local image passed the same Docker smoke without development code mounts; the approved Alice file also survived container replacement while retaining its home volume.

A separate real DeepSeek request through the restricted model proxy returned HTTP 200 and a completed SSE response containing the requested marker, without exposing the upstream key. This is separate from a real-model conversation through the deployed company entry. Linux artifacts were built with the bounded builder and recovered after fixing the final Web build invocation; local image updates used those Linux artifacts plus rebuilt gateway JavaScript. GitLab CI independently verifies a clean build from the final Dockerfile; its actual run result is reported separately.

Company SSO registration, company server/TLS entry, hard disk quotas, deployment firewall controls, image-attachment fallback, physical second-computer access, backup restoration, and independent user acceptance remain unverified. Kubernetes, a shared SQL database, and production patient-data use are outside this delivery.

</details>
