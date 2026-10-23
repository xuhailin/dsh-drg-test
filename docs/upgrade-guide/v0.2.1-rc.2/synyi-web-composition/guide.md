---
kind: upgrade-guide
description: "Synyi presentation moves from default Web configuration into an explicit optional bundle."
---

# Select the Synyi Web composition explicitly

English | [中文](guide.zh.md)

## Change

The fork's ordinary `web` profile uses upstream branding and theme defaults. Synyi presentation lives in `@deepseek-ai/dsh-synyi-web-app`; titles use the existing `DSH_CLIENT_TITLE` build variable. The hosted-workspace launcher applies the Synyi patch automatically, and its Dockerfile supplies the title.

The hosted clinical overlay selects the generated `clinical-review` preset for new Sessions. Existing Sessions retain their recorded preset and report history. This does not change patient authorization or general tools.

## Migration

1. For a source Web launch, build with `DSH_CLIENT_TITLE=森亿智能 pnpm run build:artifacts`, then run `pnpm dsh web --patch packages/bundle/synyi-web-app/cordis.patch.yml`. See the [bundle reference](../../../../packages/bundle/synyi-web-app/README.md) for custom profiles. Apply the layer once and keep it after the standard Web bundle.
2. For hosted images, use the current Dockerfile and entrypoint together. The entrypoint generates the clinical preset when the configured runtime overlay selects it, then applies company-model overrides. Operators starting the clinical overlay directly must generate and load its preset first; see [clinical review](../../../../packages/experimental/clinical-review/README.md).
3. Confirm a new clinical Session records `clinical-review`, old reports remain readable, and the branded page retains its icons and light/dark appearance. Loading a preset does not migrate an existing Session. Roll back application composition separately from retained Session data.
