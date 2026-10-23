---
description: "Synyi colors, compact corner radii, and matching startup backgrounds for Web clinical deployments."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-theme-synyi

English | [中文](README.zh.md)

## Summary

This package gives Synyi Web deployments blue actions, cool gray workspaces, compact rounded corners, and matching light and dark startup backgrounds. Users retain the standard light, dark, and system preferences and typography settings. Choose it alongside the standard theme for Synyi clinical applications.

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

Mount this plugin in the deployment composition alongside `@deepseek-ai/dsh-client-ui-theme`. It has no configuration fields. It changes presentation for the browser application rather than an individual agent preset.

```yaml
- name: '@deepseek-ai/dsh-client-ui-theme-synyi'
  id: ui-theme-synyi
```

The standard theme owns persisted preferences and font settings. This plugin follows those preferences without registering or saving another theme id. Disabling it removes its token layer and leaves any earlier layer in place.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One light/dark token dictionary supplies both bootstrap and Client rendering. Head CSS selects the startup background through `light-dark()` and the standard theme's resolved color scheme before body scripts execute. The Host then reads the standard bootstrap's body palette attribute and installs the tokens synchronously. The Client registers the same dictionary through `ctx.theme.overrideTokens`; the standard layout presenter applies updates and retracts that layer on disposal. Color, radius, gradient, and menu material choices stay in this package.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Standard theme](../ui-theme/README.md) — preferences, typography, and token overrides.
- [Web server](../../host/webserver/README.md) — index injection lifecycle.
- [Web client architecture](../../../docs/subsystems/web-client.md) — browser plugin composition.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package changes browser presentation without adding model context, tools, or Session events.

#### KV Cache effect

None; theme activation does not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The palette follows one deployment identity.

- **Standard theme required** — startup palette selection uses its body bootstrap, and Client activation requires its `theme` service.
- **Browser metadata is separate** — this package does not change titles, favicons, or install manifests.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
