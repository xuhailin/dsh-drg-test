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

### Try two accounts

Open [the local portal](http://chat.localhost:8080), select company sign-in, and choose **Sign in as Alice** on the mock SSO page. The browser should return to an origin such as `http://u-<40-hex-characters>.chat.localhost:8080` and display the existing DSH chat UI with an account/logout control. The first visit also starts Alice's personal container.

Send a short chat message. The mock response begins with `Mock DeepSeek:`. For the tool flow, send `WRITE_MARKER alice.txt` and respond to any normal DSH approval. The mock model requests the real Bash tool to write and read a marker in the personal workspace.

Use a separate browser profile or private window to sign in as **Bob**. Bob should receive a different origin and an empty independent workspace. Repeat with `WRITE_MARKER bob.txt`, then check the isolation and logout scenarios below; the expected results are acceptance targets until the verification record confirms the run.

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

The image job uses the official Docker rootless image as a shell environment; it starts neither `dockerd` nor a DinD service. It obtains BuildKit binaries and the upstream daemonless script from SHA-256-pinned layers of the official `moby/buildkit` image through `HOSTED_DOCKER_MIRROR`, verifies each archive before extracting the selected files, and runs BuildKit as the image's non-root user. The bootstrap explicitly sets `USER` to that account so BuildKit selects its writable home directories. Temporary tools and runtime files stay outside the build context and are removed on exit. The job checks namespace and build support before building the application.

`HOSTED_DOCKER_MIRROR` defaults to `docker-mirror.sh.synyi.com`. Both CI job images and BuildKit's Docker Hub resolution use this pull proxy, including the Dockerfile frontend and base image. The temporary BuildKit configuration stays outside the Docker context and is removed when the job ends.

Protect the intended default branch. The [image build script](../../../deploy/hosted-workspaces/ci-image.sh) retains build metadata as a GitLab job artifact; the image stays in the job's temporary BuildKit storage. Registry, company SSO, and model credentials are unnecessary. Image distribution for deployment requires a separately approved destination whose access controls meet the project's requirements.

-----

<a id="sso-registration"></a>
## Register the company SSO application

Ask the company identity administrator to create a separate confidential Web application. Reuse the company's SSO provider and login experience, while keeping this application's client registration distinct from EMR. No company application registration is needed for the local mock trial.

| Setting | Required value | Requirement |
|---|---|---|
| Application type | Confidential server-side Web client | Required; the gateway holds the secret |
| Client ID | `dsh-workspaces`, or the administrator-assigned ID | Required; configure the exact assigned value |
| Grant / response type | `authorization_code` / `code` | Required; do not enable implicit, password, or client-credentials grants for this application |
| Response mode | Query parameters on the callback GET | Required when the console asks for a mode |
| PKCE | Required, `S256` | Required; the gateway also verifies state and nonce |
| Token endpoint authentication | `client_secret_basic` | Required for the confidential registration |
| Scopes | `openid profile` | Required; `email` and `offline_access` are not requested |
| Local callback | `http://chat.localhost:8080/auth/callback` | Required only if real SSO will be tested at this local entry and company policy permits HTTP loopback development |
| Company callback | The chosen portal origin followed by `/auth/callback` | Required when a company entry is chosen; register the exact scheme, host, port, and path |
| Issuer and discovery | Exact issuer with matching discovery metadata | Required; an internal discovery URL cannot change the expected issuer |
| ID-token claims and signing | Stable `sub`, correct issuer/audience, RS256 signature, reachable JWKS | Required; `name` or `preferred_username` supplies a display label |
| Pilot application assignment | Administrator-selected test users or groups | Optional identity-provider access policy |
| Browser-origin allowlist | Portal origin, if the company console requires it | Optional; browsers do not call the token endpoint, so token-endpoint CORS is unnecessary |
| Provider logout callbacks | Unused by this implementation | Leave unset unless a separate provider-logout integration requires them |

For a portal such as `https://chat.example.com`, the callback is exactly `https://chat.example.com/auth/callback`. Do not register a wildcard callback or a separate callback for every personal subdomain: every OIDC callback arrives at the portal, and the gateway performs the subsequent private-origin handoff.

The identity administrator supplies the issuer, client ID, and confidential client secret through the approved secret channel. The gateway validates the ID-token signature through JWKS, issuer, audience, nonce, and the one-use login flow. Display names never select an account or runtime.

**Logout is application-local.** It revokes the browser session and closes its connections. It retains personal files and background jobs and leaves the company's global SSO session active. A later company sign-in can therefore complete without another password prompt.

-----

<a id="company-services"></a>
## Connect company services

Choose the portal origin when the server and TLS entry are known. Keep the mock overlay out of the company composition. The gateway needs network access to SSO discovery, token and JWKS endpoints, the configured model upstream, and Docker.

Use [the environment example](../../../deploy/hosted-workspaces/.env.example) for non-secret settings. Configure secret paths to existing, access-restricted files outside the checkout. Compose mounts those files only into the gateway; personal containers receive a separate restricted model credential.

```dotenv
HOSTED_PUBLIC_ORIGIN=https://chat.example.com
HOSTED_ALLOW_HTTP=false
HOSTED_OIDC_ISSUER=https://sso.example.com
HOSTED_OIDC_CLIENT_ID=dsh-workspaces
HOSTED_OIDC_CLIENT_SECRET_PATH=/srv/dsh-secrets/oidc_client_secret
HOSTED_DEEPSEEK_KEY_PATH=/srv/dsh-secrets/deepseek_api_key
```

These are replacement examples, not an existing company deployment. `HOSTED_OIDC_DISCOVERY_URL` is optional when the configured issuer is directly reachable; if an internal URL is used, its metadata must still report that issuer. Keep secret values out of `.env`, command arguments, browser settings, and committed files.

The default upstream is `https://api.deepseek.com/anthropic`; the configured model IDs are `deepseek-flash` and `deepseek-v4-pro`. The shared-key proxy permits only streaming `POST /model/v1/messages`, with per-account admission and output limits. It denies Files API operations and upstream file references. Image attachments need separate end-to-end confirmation of the DSH inline fallback.

A company entry needs DNS for both the portal and `*.portal-hostname`, plus TLS certificates covering those names. The reverse proxy must preserve Host and forward HTTP and WebSocket traffic to the gateway. Personal runtime ports remain unpublished; browsers never connect directly to a runtime container. See [public deployment forwarding](public-deployments.md) for the underlying Web transport requirements.

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
| Alice and Bob chat and write different marker files | Each account sees only its own chats, files, settings, and tool output |
| Alice presents her session on Bob's private host or supplies Bob's identifiers | The gateway rejects the request; Bob's runtime receives no operation |
| Each account has pending approval, terminal, or subagent activity | Responses and streams remain in the owning runtime |
| Alice logs out with an open WebSocket or streaming response | Alice's session loses access and its connections close; Bob remains connected |
| The browser session expires | New requests are rejected and the expired session's streams close |
| Gateway or personal runtime restarts | The correct account recovers its own history and files; another account cannot claim them |
| A tool inspects environment and readable files | The real upstream model Key is absent; only that runtime's restricted credential is available |
| A runtime tests its network and Docker access | It cannot reach another personal runtime or the Docker control socket |
| SSO, runtime startup, model upstream, or quota fails | The operation visibly fails without selecting another account or claiming success |

If the portal is unavailable, inspect Compose service status and logs. If login fails, verify the exact callback, issuer, client authentication method, and secret-file mount. For startup conflicts or cleanup failures, inspect the reported Docker resources and preserve volumes; do not rename another user's container or bypass isolation checks to make startup succeed.

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

The [requirements verification record](../../requirements/sso-private-workspaces-v1.md#dev-note) owns executed Docker, browser, tool, and model checks. Company SSO registration, company deployment, and independent user acceptance remain unperformed.

</details>
