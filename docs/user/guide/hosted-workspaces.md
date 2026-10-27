---
description: "Run a local Docker trial of company login and private DSH workspaces, then prepare an OIDC application."
---

# Company login and private Docker workspaces

English | [中文](hosted-workspaces.zh.md)

## Summary

Try company-style login and private DSH chats on a local Docker engine before choosing a server or domain. The trial supplies mock identity and model services, so it needs no company credentials or real API key. Each account receives its own browser origin, DSH container, and persistent home volume. Company SSO registration, real-model acceptance, and Linux deployment controls remain separate steps before a shared-service trial.

## Table of Contents

- [Run the local trial](#local-trial)
- [Build images with GitLab CI](#gitlab-ci)
- [Register the company SSO application](#sso-registration)
- [Connect company services](#company-services)
- [Analyze clinical pathways](#clinical-pathway-analysis)
- [Shared national references](#shared-references)
- [Isolation and operating limits](#isolation-and-limits)
- [Verify and recover](#verification-and-recovery)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="local-trial"></a>
## Run the local trial

Start from this repository checkout with Docker Engine or Docker Desktop running and Docker Compose available. Reserve local ports `8080` and `8090`. Use a browser that resolves `chat.localhost` and its subdomains to the local machine.

### Build and start

Run these commands from the repository root. The image build installs workspace dependencies and builds DSH; it needs network access and can take several minutes.

```sh
sh deploy/hosted-workspaces/build-image.sh
docker compose -f deploy/hosted-workspaces/compose.yml -f deploy/hosted-workspaces/compose.test.yml up -d
docker compose -f deploy/hosted-workspaces/compose.yml -f deploy/hosted-workspaces/compose.test.yml ps
```

The test overlay selects mock OIDC and model services and mounts synthetic fixture keys. It does not contact company SSO or DeepSeek. Keep this overlay for local synthetic data only.

Build upgrades under a new image tag or digest. Replacing a tag used by running personal containers makes the gateway reject those instances until they are recreated. Finish active turns, stop the gateway before personal containers so incoming requests cannot restart them, preserve the home volumes, and recreate the affected containers during a planned upgrade.

### Try two accounts

Open [the local portal](http://chat.localhost:8080). It automatically opens company sign-in; choose **Sign in as Alice** on the mock SSO page. The browser should return to an origin such as `http://u-<40-hex-characters>.chat.localhost:8080` and display the existing DSH chat UI with an account/logout control. The first visit also starts Alice's personal container.

Send a short chat message. The mock response begins with `Mock DeepSeek:`. For the tool flow, send `WRITE_MARKER alice.txt` and respond to any normal DSH approval. The mock model requests the real Bash tool to write and read a marker in the personal workspace.

Use a separate browser profile or private window to sign in as **Bob**. Bob should receive a different origin and an empty independent workspace. Repeat with `WRITE_MARKER bob.txt`, then check the isolation and logout scenarios below; the expected results are acceptance targets until the verification record confirms the run.

Use the portal as the bookmark. If an old personal home page needs login, the gateway returns through company sign-in and selects the current account's workspace. Signing out leaves a confirmation page with a company sign-in action, so the active company SSO session does not immediately log the user back in.

### Stop the local portal

Stop the Compose services without deleting their named volumes:

```sh
docker compose -f deploy/hosted-workspaces/compose.yml -f deploy/hosted-workspaces/compose.test.yml down
```

Personal containers are created through Docker rather than Compose; they and their volumes are retained. Background work can continue in them, although the stopped model gateway is unavailable. Operators must manage these resources separately. Do not remove the gateway's account volume independently of retained personal volumes and containers.

-----

<a id="gitlab-ci"></a>
## Build images with GitLab CI

The repository's [GitLab pipeline](../../../.gitlab-ci.yml) checks hosted-workspaces on branch pushes and merge requests. A protected default branch builds a commit-tagged image without uploading it; other protected branches offer a manual image job. Existing Python release jobs remain restricted to Python release tags. Server deployment and SSO registration require separate configuration.

Use a Linux amd64 Docker-executor runner with the tag in `HOSTED_CI_RUNNER_TAG` (default `rm-executor`, matching the company's shared Linux runners). Override this variable for another runner. Image builds use rootless BuildKit without a Docker socket or DinD service in the job. The runner must permit its user-namespace and mount operations; verify the [GitLab BuildKit requirements](https://docs.gitlab.com/ci/docker/using_buildkit/) against the runner configuration and check the image job result.

The image job uses the official Docker rootless image as a shell environment; it starts neither `dockerd` nor a DinD service. It obtains BuildKit binaries and the upstream daemonless script from SHA-256-pinned layers of the official `moby/buildkit` image through `HOSTED_DOCKER_MIRROR`, verifies each archive before extracting the selected files, and runs BuildKit as the image's non-root user. The bootstrap explicitly sets `USER` to that account, with private `XDG_DATA_HOME` and `XDG_RUNTIME_DIR` directories outside the build context. Tools and runtime files are removed on exit; BuildKit state can contain mapped user IDs and is discarded with the job container. The job checks namespace and build support before building the application.

`HOSTED_DOCKER_MIRROR` defaults to `docker-mirror.sh.synyi.com`. Both CI job images and BuildKit's Docker Hub resolution use this pull proxy, including the Dockerfile frontend and base image. The temporary BuildKit configuration stays outside the Docker context and is removed when the job ends.

Protect the intended default branch. The [image build script](../../../deploy/hosted-workspaces/ci-image.sh) retains build metadata as a GitLab job artifact; the image stays in the job's temporary BuildKit storage. Registry, company SSO, and model credentials are unnecessary. Image distribution for deployment requires a separately approved destination whose access controls meet the project's requirements.

-----

<a id="sso-registration"></a>
## Register the company SSO application

Ask the company identity administrator for a separate OIDC application and the flow it supports. The default `authorization-code` mode uses a server-side code exchange. Select `implicit` when the provider supports the existing EMR-style ID-token response without a code exchange; the company does not need to enable authorization-code flow for this integration. Reuse its login experience while keeping this application's registration distinct from EMR. The local mock trial needs no company registration.

| Setting | `authorization-code` (default) | `implicit` compatibility |
|---|---|---|
| Application type | Server-side Web client; confidential when a secret is issued | OIDC client permitting an ID-token response |
| Client ID | Exact administrator-assigned value, such as `dsh-workspaces` | Exact administrator-assigned value, such as `dsh-workspaces` |
| Grant / response type | `authorization_code` / `code` | `implicit` / `id_token`; no access-token response |
| Response mode | Query parameters on the callback GET | URL fragment on the callback page |
| PKCE, state, and nonce | `S256` PKCE, browser-bound state, and nonce | Browser-bound state and nonce; no code verifier |
| Token endpoint authentication | `client_secret_basic` for a confidential client; no secret for a public client | No token-endpoint exchange or client secret |
| Scopes | `openid profile` | `openid profile` |
| Local callback | `http://chat.localhost:8080/auth/callback`, only when company policy permits local HTTP testing | `http://chat.localhost:8080/auth/callback`, only when company policy permits local HTTP testing |
| Company callback | Chosen portal origin followed by `/auth/callback`; exact scheme, host, port, and path | Chosen portal origin followed by `/auth/callback`; exact scheme, host, port, and path |
| Issuer and discovery | Exact issuer with matching discovery metadata | Exact issuer with matching discovery metadata |
| ID-token claims and signing | Stable `sub`, correct issuer/audience, RS256 signature, reachable JWKS | Stable `sub`, correct issuer/audience, RS256 signature, reachable JWKS |
| Pilot application assignment | Administrator-selected test users or groups | Administrator-selected test users or groups |
| Browser-origin allowlist | Portal origin if required by the company console | Portal origin if required by the company console |
| Provider logout callbacks | Unused by this implementation | Unused by this implementation |

For a portal such as `https://chat.example.com`, the callback is exactly `https://chat.example.com/auth/callback`. Do not register a wildcard callback or a separate callback for every personal subdomain: every OIDC callback arrives at the portal, and the gateway performs the subsequent private-origin handoff.

The administrator supplies the issuer, client ID, supported flow, and reachable JWKS; a confidential authorization-code client also needs its secret through the approved secret channel. `name` or `preferred_username` supplies a display label and never selects an account or runtime. The gateway validates the signed ID token, issuer, audience, expiry, nonce, and one-use browser-bound state in either mode.

In implicit mode, the callback page removes the fragment from the address bar and sends its fields to the gateway by same-origin POST. The gateway verifies the token through the provider's JWKS before creating a browser session; an unverified browser-decoded token cannot authenticate. DSH requests only an ID token for identity, not EMR business access or refresh tokens. It uses no password grant and stores no SSO token in localStorage. Browsers do not call the token endpoint, so token-endpoint CORS is unnecessary.

If the callback is reopened without response fields while a live DSH session exists, it resumes through the portal. A real response carrying state is still validated. Verification and workspace opening show a DRG Agent loading page; the retry action appears when sign-in cannot continue.

**Logout is application-local.** It revokes the browser session and closes its connections. It retains personal files and background jobs and leaves the company's global SSO session active. A later company sign-in can therefore complete without another password prompt.

-----

<a id="company-services"></a>
## Connect company services

Choose the portal origin when the server and TLS entry are known. Keep the mock overlay out of the company composition. The gateway needs network access to SSO discovery and JWKS endpoints, the configured model upstream, and Docker. Authorization-code mode also needs the token endpoint; implicit mode does not use it.

Use [the environment example](../../../deploy/hosted-workspaces/.env.example) for non-secret settings. Configure secret paths to existing, access-restricted files outside the checkout. Compose mounts those files only into the gateway; personal containers receive a separate restricted model credential.

```dotenv
HOSTED_PUBLIC_ORIGIN=https://chat.example.com
HOSTED_ALLOW_HTTP=false
HOSTED_OIDC_ISSUER=https://sso.example.com
HOSTED_OIDC_CLIENT_ID=dsh-workspaces
HOSTED_OIDC_FLOW=authorization-code
HOSTED_OIDC_CLIENT_SECRET_PATH=/srv/dsh-secrets/oidc_client_secret
HOSTED_DEEPSEEK_KEY_PATH=/srv/dsh-secrets/deepseek_api_key
```

For an implicit application, set `HOSTED_OIDC_FLOW=implicit`. This mode does not read `clientSecretFile`. The base Compose file retains the default code-flow secret mount; remove `oidc_client_secret` from the gateway's mounted secrets and top-level secret definitions in the company composition when no client-secret file is supplied. Keep the DeepSeek secret mounted only in the gateway.

These are replacement examples, not an existing company deployment. `HOSTED_OIDC_DISCOVERY_URL` is optional when the configured issuer is directly reachable; if an internal URL is used, its metadata must still report that issuer. Keep secret values out of `.env`, command arguments, browser settings, and committed files.

The default upstream is `https://api.deepseek.com/anthropic`; the configured model IDs are `deepseek-flash` and `deepseek-v4-pro`. The shared-key proxy applies per-account admission and output limits. Company Responses-compatible models use `modelProtocol: openai-responses` and explicit `modelKeyFile` / `modelBaseUrl` settings; the [package reference](../../../packages/experimental/hosted-workspaces/README.md#configuration) defines endpoint prefixes and the stateless request restrictions. Images need separate end-to-end confirmation.

At startup, the company-model composition applies its compaction policy to the four bundled Web presets, `clinical-pathway-analysis`, and `clinical-review` when enabled, without changing their tools. It gives its route 4,096 tokens each for compaction headroom, summary output, and retained recent history, fitting the default 32K context and 8K output. Recheck the [compaction policy](../../../packages/compaction/compaction-basic/README.md#use-this-package) when changing capacities so history does not consume the model's output space.

A company entry needs DNS for both the portal and `*.portal-hostname`, plus TLS certificates covering those names. The reverse proxy must preserve Host and forward HTTP and WebSocket traffic to the gateway. Personal runtime ports remain unpublished; browsers never connect directly to a runtime container. See [public deployment forwarding](public-deployments.md) for the underlying Web transport requirements.

-----

<a id="clinical-pathway-analysis"></a>
## Analyze clinical pathways

Choose **临床路径分析** (`clinical-pathway-analysis`) for a new hosted chat. The default hosted runtime includes this preset independently of the optional encounter-review overlay and requires no database connection. Supply authorized exports, existing pathway documents, or clinical reference material.

Ask for a v1 new-pathway reference, analysis of supplied execution/variation evidence, or a v2 reference showing before/after changes requested by the user. The preset instructs the model to identify sources, the population and time period, denominator completeness, and execution evidence. It distinguishes order entry from actual execution, and separates reasonable exceptions, unexplained variation, and unknowns. Partial exports support sample findings only; frequent historical practice alone does not establish a clinical recommendation.

Both v1 and v2 remain private conversation or user-requested reference files, not hospital drafts or business versions. The optional [read-only reader](../../../packages/experimental/clinical-pathway-reader/README.md) supplies definitions, cohorts and encounter evidence. Explicitly select `compose.clinical-pathway.yml` for standalone reads; also layer `compose.clinical-with-pathway.yml` to retain the insurance entry. Database credentials stay in the gateway, and the connection must pass source and read-only-transaction checks. Default access requires a SELECT-only role; explicit development integration may select `development-transaction-only` without changing grants. No writeback, review/publication or realtime monitoring is provided.

-----

<a id="shared-references"></a>
## Optional encounter review

The clinical pilot adds the [gateway reader](../../../packages/experimental/emr-reader-broker/README.md), [private review workflow](../../../packages/experimental/clinical-review/README.md), and [browser entry](../../../packages/experimental/client-emr-entry/README.md). Add `compose.clinical.yml` to the existing Compose files and configure its source-system, database-configuration, binding-key, and encounter-allowlist paths from `.env.example`. These files mount only in the gateway. Configure exact browser origins and source/hospital defaults in the image-owned `clinical.runtime.patch.yml` before building.

Sign in at the existing portal, choose the encounter entry, and submit an allowed encounter identifier. Opening the Session does not start a model request; choose pre-discharge review to collect evidence and start an advisory review. The browser entry package contains an EMR embedding example. Production EMR discharge handlers must remain independent of review acknowledgements; no clinical write or discharge interception is installed by this overlay. DRG/DIP calculation remains unavailable in this stage.

## Shared national references

Prepare a source-only collection with [the operator resource utility](../../../packages/experimental/drg-resources/README.md), then set `HOSTED_SHARED_RESOURCES_PATH` to its `published` directory on the Docker daemon host. The directory must already exist; the gateway does not create it. Add [compose.resources.yml](../../../deploy/hosted-workspaces/compose.resources.yml) to the same Compose invocation as the base and your selected service overlay.

Each personal runtime reads the collection at `/opt/dsh/resources`; `DSH_SHARED_RESOURCES_ROOT` records that location in the runtime process environment. DSH command subprocesses filter `DSH_*` values, so Bash reads use the fixed path. Only the published directory is shared. Staging, private homes, credentials, and the Docker socket remain outside it. The bind excludes nested mounts, uses private propagation, and rejects writes even when tool execution is approved. National source archives record `profile: source-only` and `groupingReady: false`; a reference default permits reading, not grouping.

The repository image includes `pdftotext` and an opt-in `drg-national-reference` bundled skill. With the shared mount enabled, a fresh chat using the standard, PTC, or Cordis preset can discover the skill and read the references from a natural-language request, such as “Which national DRG references are installed? Read their contents and cite the edition and PDF pages.” Keep the company SSO/model composition to use real services; the mock overlay is only for automated tests. Approve normal tool requests when needed. The minimal preset has no skill tool and does not provide this discovery. Source-only answers explain the publication; they do not calculate a verified group.

Enabling this option changes required personal-container mounts. Existing containers report `resource_conflict` until an operator replaces them using the home-preserving procedure below; a restart cannot add a mount. Back up identity mappings and homes and finish active work first. Disabling the option likewise needs controlled replacement of containers that still carry the shared mount. Publication, default rollback, withdrawal, and backup verification belong to the resource utility; the SSO gateway grants no publication role.

-----

<a id="isolation-and-limits"></a>
## Isolation and operating limits

The gateway maps verified issuer and subject to a stable account, then chooses its container and volume. It rejects a session presented on another account's private origin. HTTP APIs, uploads/downloads, and WebSocket upgrades pass through this same authenticated entry; browser-supplied user IDs, runtime addresses, and forwarded headers do not select the target.

Each personal runtime has its own home volume and bridge network. Its home contains DSH data, settings, installed plugins, files, and workspace state. The container runs as UID/GID `1000:1000`, with a read-only image, dropped capabilities, `no-new-privileges`, and a size-limited `/tmp`. Only the gateway mounts the Docker socket and upstream secret files.

The default per-container limits are 2 GiB memory, 2 CPUs, 256 PIDs, and 256 MiB temporary storage. Defaults also limit registered accounts to 20 and shared-key model calls to 30 per minute with 2 concurrent requests per account. The [package reference](../../../packages/experimental/hosted-workspaces/README.md#configuration) links the authoritative configuration and describes the remaining bounds.

**Persistent disk has no hard quota in this implementation.** A named volume separates data ownership but does not prevent one account filling the host disk. Before shared Linux use, configure and verify filesystem/project quotas or another enforced storage limit for the actual Docker storage backend. Backup, disk-full recovery, retention, and network/firewall verification belong to that deployment's acceptance.

Signing out does not terminate an account's background tasks or container. Their resource limits and model admission still apply. There is no automatic idle stop, multi-gateway coordination, hospital/department authorization, or patient-system integration in this trial.

-----

<a id="verification-and-recovery"></a>
## Verify and recover

Use synthetic data for the local trial. Run the following scenarios through the browser entry and inspect actual results; unit checks alone do not accept the deployment.

| Scenario | Required observation |
|---|---|
| Open the portal with no DSH session, then revisit with a live session | Company sign-in starts automatically; the live session opens its own workspace |
| Open an expired personal home bookmark, then sign in as another account | The verified current account opens its own workspace; the old host does not choose the destination |
| Alice and Bob chat and write different marker files | Each account sees only its own chats, files, settings, and tool output |
| Alice presents her session on Bob's private host or supplies Bob's identifiers | The gateway rejects the request; Bob's runtime receives no operation |
| Each account has pending approval, terminal, or subagent activity | Responses and streams remain in the owning runtime |
| Alice logs out with an open WebSocket or streaming response | Alice's session loses access and its connections close; Bob remains connected |
| The browser session expires | New requests are rejected and the expired session's streams close |
| Gateway or personal runtime restarts | The correct account recovers its own history and files; another account cannot claim them |
| A tool inspects environment and readable files | The real upstream model Key is absent; only that runtime's restricted credential is available |
| A runtime tests its network and Docker access | It cannot reach another personal runtime or the Docker control socket |
| An implicit callback has a forged, expired, wrong-audience, or replayed ID token | The gateway rejects authentication and creates no browser session |
| SSO, runtime startup, model upstream, or quota fails | The operation visibly fails without selecting another account or claiming success |

If the portal is unavailable, inspect Compose service status and logs. A sign-in failure offers a new login attempt; a workspace failure offers a retry. Gateway failure logs identify the operation and a safe category code rather than raw errors or token values. For login failures, verify the exact callback, issuer, configured flow, and JWKS access. For authorization-code clients, also verify token-endpoint authentication and any client-secret mount. For startup conflicts or cleanup failures, inspect the reported Docker resources and preserve volumes; do not rename another user's container or bypass isolation checks to make startup succeed.

Mock completion verifies the local code path only. Company acceptance still requires the registered real SSO application, a real DeepSeek streaming request, two test identities, the intended Linux networking/storage controls, and independent user acceptance. It does not authorize real patient data.

Persistent volumes and account mappings survive container restarts. Image replacement is separate: finish or stop active work, back up the gateway and home volumes, remove each old personal container without `-v`, and retain its named volume and the same resource prefix. The next authenticated request recreates it with the configured image. A restart alone keeps the old image; the gateway rejects a container whose image differs from its configuration. Validate the new image with synthetic accounts before replacing shared runtimes.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Hosted-workspaces package](../../../packages/experimental/hosted-workspaces/README.md) — configuration, retained work, and implementation ownership.
- [Private-workspace requirements](../../requirements/sso-private-workspaces-v1.md) — agreed scope and acceptance criteria.
- [Web application](../../../packages/bundle/web-app/README.md) — the personal chat and tool environment.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working verification context — click to expand</summary>

The [requirements verification record](../../requirements/sso-private-workspaces-v1.md#dev-note) owns executed Docker, browser, tool, and model checks. Company callback registration and a real-account home-page visit have been observed. The [reference integration record](../../requirements/drg-review-assistant-v1-implementation.md#dev-note) covers the fresh standard chat through company SSO/DeepSeek, automatic skill loading, digest verification, and PDF page citations; company deployment and independent user acceptance remain pending.

Fixed pathway SQL passes isolated PostgreSQL synthetic verification and development schema checks. Approved development source reads pass in enforced read-only transactions; deployed clinical inference and user acceptance remain unverified. Coverage gaps, incomplete imports and retained reasons cannot establish population-wide missing-data rates or a complete variation history.

</details>
