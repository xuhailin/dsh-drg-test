---
description: "Optional Synyi branding and theme for a Web profile, with deployment-owned titles and unchanged agent tools."
kind: "package-bundle"
---

# @deepseek-ai/dsh-synyi-web-app

English | [中文](README.zh.md)

## Summary

This optional layer gives a standard Web profile the Synyi brand, page assets, palette, and compact radii. The hosted-workspace launcher applies it before deployment-specific patches. The ordinary Web bundle retains its upstream presentation. Agent tools and clinical behavior belong to their existing presets and plugins.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The [hosted deployment](../../../deploy/hosted-workspaces/entrypoint.sh) applies this package's `cordis.patch.yml` through `dsh --patch`, including for existing managed profiles. It does not rewrite saved profile manifests. The [image build](../../../deploy/hosted-workspaces/Dockerfile) supplies `DSH_CLIENT_TITLE=森亿智能` through the existing build environment.

From a built checkout, apply the same layer locally:

```sh
pnpm dsh web --patch packages/bundle/synyi-web-app/cordis.patch.yml
```

The title comes from the built artifacts. Build with `DSH_CLIENT_TITLE=森亿智能 pnpm run build:artifacts` when the title should match this brand. A custom profile may instead list this bundle after `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`; all three packages must be resolvable from that profile. Apply the presentation layer only once.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) disables `ui-brand-official` and inserts `ui-brand-synyi` and `ui-theme-synyi`. The brand plugin owns slot occupants, favicon routes, and manifest links; the theme plugin owns token overrides and first-paint styles. Disabling the official occupant avoids duplicate registrations in the same brand slots.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Brand plugin](../../client/ui-brand-synyi/README.md)
- [Theme plugin](../../client/ui-theme-synyi/README.md)
- [Profile composition](../../boot/app-boot/README.md)

<a id="model-experience"></a>
## Model Experience

None, as this bundle contributes presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Web composition required** — the layer depends on the standard Web composition and its existing slot names.
- **Build-time title** — the shell and client bundles share the same build value.
- **Web only** — this layer does not change standalone static-worker or Desktop composition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
