---
description: "Synyi logo and localized name for the sidebar and welcome screen; for deployments that use Synyi branding."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-synyi

English | [中文](README.zh.md)

## Summary

This package displays the Synyi logo in the sidebar and conversation welcome screen. The sidebar name follows the selected language: 森亿智能 in Chinese and SYNYI AI in English. Choose it for Synyi deployments; it does not change model requests or functional icons.

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

Mount this plugin through a deployment bundle or profile patch, and disable `ui-brand-official` in that composition. The default Web bundle keeps the official brand. This plugin requires the Host Web server and has no configuration fields.

The sidebar and welcome screen use the supplied Synyi mark from EMR. The brand name uses the shared theme's text color in light and dark mode. The Host serves the package's light/dark favicons and install manifest under `synyi-brand/`, replacing the shell's brand links. Relative URLs preserve a reverse proxy's application path. Set `DSH_CLIENT_TITLE=森亿智能` for the deployment's complete default-profile build; the official build profile retains the official title.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser entry waits for each owning slot declaration before contributing artwork. The sidebar mark and name register together; the welcome mark registers independently. Declaration teardown and plugin disposal remove their occupants. The Host loads packaged assets during activation; missing files fail activation. GET and HEAD serve those assets, other methods return 405, and plugin disposal removes their routes and index transform. The bundled PNG preserves the supplied Synyi artwork.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-sidebar](../ui-sidebar/README.md) — sidebar brand slots and their fallback presentation.
- [ui-conversation](../ui-conversation/README.md) — conversation welcome screen.
- [Web Client architecture](../../../docs/subsystems/web-client.md) — browser plugin composition.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser brand presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Brand presentation uses one deployment identity.

- **One brand plugin** — do not mount another occupant for the same brand slots.
- **Title is build-time** — the deployment supplies the same `DSH_CLIENT_TITLE` to the Web shell and client plugins; loading the brand plugin alone does not change document titles.
- **HTTP shell required** — asset routes and metadata replacement apply to the Host-served Web document; standalone static-worker shells do not run the index transform.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
