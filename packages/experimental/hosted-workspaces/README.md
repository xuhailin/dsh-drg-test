---
description: "Company SSO portal with private Docker workspaces and restricted shared-key model access."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-hosted-workspaces

English | [中文](README.zh.md)

## Summary

Open a company sign-in portal and give each account a private DSH Web environment. The repository Docker image supplies a dedicated gateway profile; ordinary profiles do not enable this layer. Personal containers retain chats, files, terminals, and tool interactions, while a separate model proxy holds the upstream key. This experimental deployment requires Docker control access and separate browser origins; local mock checks do not establish readiness for patient data.

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

Use the [Docker trial guide](../../../docs/user/guide/hosted-workspaces.md) to build the repository image and start its company-login portal. The local composition provides mock OIDC and model services without a company server, registered SSO application, or real API key.

### Profile supplied by the repository image

The image includes this workspace package and a dedicated [gateway profile manifest](../../../deploy/hosted-workspaces/profile/package.json). The entrypoint starts that profile through `dsh --profile gateway`; each personal container starts the existing `web` profile. Registry installation is not part of this repository trial.

The bundle's [patch](cordis.patch.yml) mounts its own webserver, gateway storage, and login plugin. Keep it in the dedicated gateway profile: it owns that server's fallback route and does not compose an agent. Personal runtimes own their existing Web tools and settings.

<a id="configuration"></a>
### Configuration

The [configuration schema](src/config.ts) owns the complete field list. The patch reads deployment environment values; Compose supplies the entry settings and gateway-only secret-file mounts.

| Input | Default | Meaning |
|---|---|---|
| `publicOrigin` | Required | Bare portal origin; personal origins are its direct subdomains |
| `issuer`, `clientId` | Required | Registered OIDC provider and application |
| `discoveryUrl` | Issuer discovery | Optional internal discovery URL; the returned issuer must still match |
| `oidcFlow` | `authorization-code` | Authorization-code login, or `implicit` for providers that return only an ID token |
| `clientSecretFile` | Unset | Gateway-only secret for confidential authorization-code clients; ignored in implicit mode |
| `modelProtocol` | `anthropic-messages` | Messages or `openai-responses` streaming protocol |
| `modelKeyFile`, `modelBaseUrl` | Unset | Explicit gateway-only key file and protocol API base; both required for Responses |
| `runtimeModel`, `runtimeContextWindow`, `runtimeMaxTokens` | Unset, `32768`, `8192` | Responses runtime model and deployment budgets; model must be allowed and output must fit both limits |
| `runtimePatchFile` | Unset | Optional normalized image-owned overlay under `/opt/dsh/` |
| `deepseekKeyFile`, `deepseekBaseUrl` | Key required; `https://api.deepseek.com/anthropic` | Legacy Messages settings used when the corresponding generic field is absent |
| `allowedModels` | `deepseek-flash`, `deepseek-v4-pro` | Models admitted by the shared-key proxy |
| `allowHttp` | `false` | Explicit development-only HTTP permission; the local Compose trial enables it |
| `sessionTtlMs`, `flowTtlMs` | 12 hours, 5 minutes | Absolute browser-session and login-attempt lifetimes |
| `maxCallbackBytes` | 64 KiB | Maximum implicit callback body before token parsing and verification |
| `maxUsers`, `maxBrowserSessions` | `20`, `200` | Durable account and live browser-session admission limits |
| `containerMemoryBytes`, `containerNanoCpus`, `containerPidsLimit` | 2 GiB, 2 CPUs, `256` | Limits applied to every personal container |
| `containerTmpBytes` | 256 MiB | Personal-container `/tmp` tmpfs size |
| `sharedResourcesPath` | Unset | Optional normalized absolute directory on the Docker daemon host, mounted read-only at `/opt/dsh/resources` |
| `maxRequestsPerWindow`, `rateWindowMs`, `maxConcurrentModelRequests` | `30`, 60 seconds, `2` | Per-account shared-key model admission |
| `maxModelRequestBytes`, `maxOutputTokens` | 32 MiB, `256000` | Model request bytes and requested output-token ceiling |
| `maxIndexResponseBytes`, `maxProxyConnectionsPerUser` | 2 MiB, `64` | Decoded/modified index bytes and simultaneous personal proxy connections |

For Responses, `modelBaseUrl` includes the API prefix, for example `https://models.example.test/v1`; the proxy appends `/responses`. Messages appends `/v1/messages` to its API base. A deployment selects one protocol and an explicit model allowlist. Personal runtimes use the existing [pi-ai adapter](../../llm/llm-pi-ai/README.md) for Responses and keep their account token in `HOSTED_MODEL_API_KEY`; the company key stays in the gateway.

### Identity and retained work

Opening the portal `/` automatically starts company sign-in, or hands a live session to its personal workspace. An anonymous request for a personal `/` or `/index.html` returns through the portal without carrying that old origin as a login target; the verified identity selects the destination. Explicit `/?signedout=1` stays on the signed-out page until the user signs in again.

The gateway derives an account from verified OIDC issuer and subject. It chooses the personal runtime from its own account record, checks the browser origin, and replaces browser credentials with a backend-only DSH cookie. Runtime credentials authorize the model proxy and optional `/runtime/` handlers; the upstream key does not enter personal containers. Handlers receive the verified account, a cancellation signal, and a current-login check, and own resource authorization. Clinical reads require at least one unexpired browser login for that account; signing out one browser does not revoke another active login.

Signing out revokes that browser session and closes its admitted connections. It retains personal data and background work, and it does not sign out the company identity-provider session. Gateway restart preserves account records and existing containers; gateway storage and personal volumes must be backed up together.

When `sharedResourcesPath` is set, each personal runtime receives `DSH_SHARED_RESOURCES_ROOT=/opt/dsh/resources` and one non-recursive, read-only bind of the published collection. The manager verifies its source, target, read-only state, and private propagation before reuse. Prepare the collection with [the resource utility](../drg-resources/README.md); the gateway does not validate pack contents or grant grouping readiness. An existing container with different mounts returns `resource_conflict`; an operator must replace it while retaining its home volume. Leaving the option unset retains the resource-free runtime.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The gateway defaults to authorization-code login with PKCE, nonce, and browser-bound state. Its implicit compatibility mode requests only `id_token`; the callback page removes the URL fragment and sends it by same-origin POST for server-side signature, issuer, audience, expiry, nonce, and state validation. Neither mode uses a password grant or requests an EMR business access token. DSH stores neither ID nor access tokens in localStorage. The [registration guide](../../../docs/user/guide/hosted-workspaces.md#sso-registration) owns provider settings.

The gateway transfers the verified browser session to the account's separate origin through a short-lived, single-use handoff. The implicit fragment bridge restricts forms to CSP `form-action 'self'`. Its POST returns an HTTP 200 portal page with `form-action 'none'` and a meta refresh to that handoff. The handoff returns a document that starts a fresh same-origin navigation, ending the identity provider's redirect chain. The account/logout row reserves space above the DSH application. HTTP and WebSocket requests reach only the runtime selected by that live session.

DRG Agent status pages distinguish sign-in recovery from workspace recovery and display loading during verification and handoff. An empty implicit callback with a live session resumes through the portal; a fragment carrying state still undergoes validation. Gateway failure logs contain only the operation and a safe category code, excluding raw error messages, OAuth/JWT values, and secrets.

Docker control requests use the configured `dockerSocket` even when the environment defines `DOCKER_HOST` or Docker TLS settings. Docker owns one named home volume and bridge network per account. Startup checks existing resource ownership and isolation settings before reuse. The model proxy listens on the gateway's concrete personal-network addresses and enforces request limits outside the user container. Failed startup removes resources created by that operation; a cleanup failure requires operator inspection.

| Source | Responsibility |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml), [`src/index.ts`](src/index.ts) | Dedicated profile composition and lifetime ownership |
| [`src/oidc.ts`](src/oidc.ts), [`src/state.ts`](src/state.ts) | Verified identity, persistent accounts, and revocable sessions |
| [`src/gateway.ts`](src/gateway.ts), [`src/proxy.ts`](src/proxy.ts) | Origin admission, routing, streaming, and connection closure |
| [`src/docker.ts`](src/docker.ts), [`src/model.ts`](src/model.ts) | Personal Docker resources and restricted upstream-key use |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Docker trial and SSO registration](../../../docs/user/guide/hosted-workspaces.md) — local startup, company settings, and acceptance scenarios.
- [Experimental packages](../README.md) — support status and package selection.
- [Web application](../../bundle/web-app/README.md) — the personal runtime's existing browser surface.
- [Public deployments](../../../docs/user/guide/public-deployments.md) — external Host, TLS, and WebSocket forwarding.

-----

<a id="model-experience"></a>
## Model Experience

### Forwarded model requests

#### What the model sees

The personal Web profile owns prompts, tools, and logged conversation content. This layer forwards admitted requests and adds no prompt text or tool schema. The selected protocol accepts streaming `POST /model/v1/messages` or `POST /model/v1/responses`. Files operations and upstream file references are rejected. Responses is stateless (`store: false`); stored-response, conversation, prompt, and item references, background jobs, and provider-hosted tools are rejected. Function tools and their complete local results remain available. With shared references enabled, the repository entrypoint exposes the bundled `drg-national-reference` skill to presets that support skills. The existing skill catalog and loaded body are persisted by those tools; no user instruction file is overwritten.

#### Token effect

The gateway adds no model-input tokens. The optional reference skill adds its catalog summary and, when loaded, its instructions and selected source excerpts through existing logged tools. The proxy caps the selected protocol’s `max_tokens` or `max_output_tokens` value and admits only configured model IDs.

#### KV Cache effect

The gateway adds no cache prefix or cache-control fields. The personal runtime and upstream provider determine reuse for the forwarded request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Experimental trial** — real company SSO, real model streaming, and deployment-specific isolation require separate acceptance; this layer makes no production or patient-data readiness claim.
- **Disk quotas require host configuration** — Docker named volumes have no enforced per-account hard quota here. Configure and verify Linux filesystem/project quotas before granting access to shared server storage.
- **One gateway instance** — pending login flows, connection tracking, and runtime startup ownership are process-local; replicas and distributed admission are unsupported.
- **Retained background work** — logout does not stop tools or containers, and no idle-stop policy is provided. Operators own retention, backup, and eventual resource removal.
- **Files API is unavailable** — inline-image fallback through the real personal runtime requires end-to-end verification before relying on image attachments.
- **Linux tool availability** — installed binaries, integrations, and container permissions determine which Web-profile tools can run; desktop-specific operations are not supplied by this image.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [requirements verification record](../../../docs/requirements/sso-private-workspaces-v1.md#dev-note) owns executed checks and their limits. Company callback registration and a real-account home-page visit have been observed. The [reference integration record](../../../docs/requirements/drg-review-assistant-v1-implementation.md#dev-note) covers the fresh standard chat through company SSO/DeepSeek, automatic skill loading, digest verification, and PDF page citations; company deployment and independent user acceptance remain pending.

</details>
