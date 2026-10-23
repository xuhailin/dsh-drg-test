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

The Web application bundle mounts this plugin in place of `ui-brand-official`. It applies to all client build profiles and has no configuration fields.

The sidebar and welcome screen use the supplied Synyi mark from EMR. The brand name uses the shared theme's text color in light and dark mode. Browser icons and install metadata belong to `apps/web`. Complete repository builds use 森亿智能 as the document title; `DSH_CLIENT_TITLE` overrides it at build time.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser entry waits for each owning slot declaration before contributing artwork. The sidebar mark and name register together; the welcome mark registers independently. Declaration teardown and plugin disposal remove their occupants. The node entry contributes no Host behavior. The bundled PNG preserves the supplied Synyi artwork.

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
- **Browser metadata is separate** — slot contributions do not change the browser title, favicon, or install manifest.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
