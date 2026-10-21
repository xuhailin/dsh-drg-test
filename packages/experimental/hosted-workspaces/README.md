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
| `clientSecretFile` | Unset | Confidential-client secret file; required for the recommended company registration |
| `deepseekKeyFile` | Required | Upstream key file mounted only into the gateway |
| `deepseekBaseUrl` | `https://api.deepseek.com/anthropic` | Messages-compatible upstream |
| `allowedModels` | `deepseek-flash`, `deepseek-v4-pro` | Models admitted by the shared-key proxy |
| `allowHttp` | `false` | Explicit development-only HTTP permission; the local Compose trial enables it |
| `sessionTtlMs`, `flowTtlMs` | 12 hours, 5 minutes | Absolute browser-session and login-attempt lifetimes |
| `maxUsers`, `maxBrowserSessions` | `20`, `200` | Durable account and live browser-session admission limits |
| `containerMemoryBytes`, `containerNanoCpus`, `containerPidsLimit` | 2 GiB, 2 CPUs, `256` | Limits applied to every personal container |
| `containerTmpBytes` | 256 MiB | Personal-container `/tmp` tmpfs size |
| `maxRequestsPerWindow`, `rateWindowMs`, `maxConcurrentModelRequests` | `30`, 60 seconds, `2` | Per-account shared-key model admission |
| `maxModelRequestBytes`, `maxOutputTokens` | 32 MiB, `256000` | Model request bytes and requested output-token ceiling |
| `maxIndexResponseBytes`, `maxProxyConnectionsPerUser` | 2 MiB, `64` | Decoded/modified index bytes and simultaneous personal proxy connections |

### Identity and retained work

The gateway derives an account from verified OIDC issuer and subject. It chooses the personal runtime from its own account record, checks the browser origin, and replaces browser credentials with a backend-only DSH cookie. Runtime credentials authorize only the model proxy's allowed operations; the upstream key does not enter personal containers.

Signing out revokes that browser session and closes its admitted connections. It retains personal data and background work, and it does not sign out the company identity-provider session. Gateway restart preserves account records and existing containers; gateway storage and personal volumes must be backed up together.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The gateway completes authorization-code login with PKCE, nonce, and browser-bound state. It transfers the resulting browser session to the account's separate origin through a short-lived, single-use handoff. The handoff returns a document that starts a fresh same-origin navigation, ending the identity provider's redirect chain. The account/logout row reserves space above the DSH application. HTTP and WebSocket requests reach only the runtime selected by that live session.

Docker owns one named home volume and bridge network per account. Startup checks existing resource ownership and isolation settings before reuse. The model proxy listens on the gateway's concrete personal-network addresses and enforces request limits outside the user container. Failed startup removes resources created by that operation; a cleanup failure requires operator inspection.

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

The personal Web profile owns prompts, tools, and logged conversation content. This layer forwards admitted Messages requests and adds no prompt text or tool schema. It accepts only streaming `POST /model/v1/messages`; Files operations and upstream file references are rejected.

#### Token effect

The gateway adds no model-input tokens. The personal runtime's existing context and tools determine token use; the proxy caps the requested `max_tokens` value and admits only configured model IDs.

#### KV Cache effect

The gateway adds no cache prefix or cache-control fields. The personal runtime and upstream provider determine reuse for the forwarded request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Experimental trial** — real company SSO, real DeepSeek streaming, and deployment-specific isolation require separate acceptance; this layer makes no production or patient-data readiness claim.
- **Disk quotas require host configuration** — Docker named volumes have no enforced per-account hard quota here. Configure and verify Linux filesystem/project quotas before granting access to shared server storage.
- **One gateway instance** — pending login flows, connection tracking, and runtime startup ownership are process-local; replicas and distributed admission are unsupported.
- **Retained background work** — logout does not stop tools or containers, and no idle-stop policy is provided. Operators own retention, backup, and eventual resource removal.
- **Files API is unavailable** — inline-image fallback through the real personal runtime requires end-to-end verification before relying on image attachments.
- **Linux tool availability** — installed binaries, integrations, and container permissions determine which Web-profile tools can run; desktop-specific operations are not supplied by this image.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [requirements verification record](../../../docs/requirements/sso-private-workspaces-v1.md#dev-note) owns executed local checks and their limits. Company SSO registration, server deployment, and independent user acceptance remain unperformed.

</details>
