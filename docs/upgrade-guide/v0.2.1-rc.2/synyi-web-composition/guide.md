---
kind: upgrade-guide
description: "Synyi presentation moves from default Web configuration into an explicit optional bundle."
---

# Select the Synyi Web composition explicitly

English | [中文](guide.zh.md)

## Change

The fork's ordinary `web` profile uses upstream branding and theme defaults. Synyi presentation lives in `@deepseek-ai/dsh-synyi-web-app`; titles use the existing `DSH_CLIENT_TITLE` build variable. The hosted-workspace launcher applies the Synyi patch automatically, and its Dockerfile supplies the title.

The hosted clinical overlay selects `clinical-review`, displayed as “医保助手”, for new Sessions. Its explicit `clinical.preset.yml` replaces the former derivation from Standard: repository instructions and coding plan mode are absent, and `clinical-prompt.mjs` suppresses Harness-development context within the clinical scope. General tools, company model policy, and patient authorization remain in place. Existing Sessions retain their preset identifier and report history; restarting a `clinical-review` Session uses the current definition, while Standard Sessions keep Standard.

## Migration

1. For a source Web launch, build with `DSH_CLIENT_TITLE=森亿智能 pnpm run build:artifacts`, then run `pnpm dsh web --patch packages/bundle/synyi-web-app/cordis.patch.yml`. See the [bundle reference](../../../../packages/bundle/synyi-web-app/README.md) for custom profiles. Apply the layer once and keep it after the standard Web bundle.
2. For hosted images, include `deploy/hosted-workspaces/clinical.preset.yml` and `clinical-prompt.mjs` with the current generator and entrypoint. The entrypoint loads the clinical declaration when the runtime overlay selects it, then applies company-model overrides. Operators starting the clinical overlay directly must generate and load its preset first; see [clinical review](../../../../packages/experimental/clinical-review/README.md). Use `DSH_CLIENT_TITLE=医保助手` when building the clinical product's page title.
3. Confirm a new clinical Session records `clinical-review`, its welcome reads “医保助手”, and the complete prompt omits repository-development and coding-plan instructions while keeping general tools. Confirm old reports remain readable and the page retains its icons and light/dark appearance. Preset loading does not rewrite retained logs or convert Standard Sessions. Roll back application composition separately from retained Session data.
