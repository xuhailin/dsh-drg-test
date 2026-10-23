# Customization conventions and extension points

English | [中文](customization.zh.md)

This reference helps contributors choose extension points for DSH customization, distinguish requirements from defaults, and handle exceptions. It supplements existing standards without replacing them or adding approval or checking procedures.

## Requirements, defaults, and exceptions

| Level | Meaning |
|---|---|
| Hard requirements | Follow the current version's existing runtime, dependency, security, and compatibility requirements, together with the product behavior already agreed for the task. The owning references below retain the detailed rules. |
| Default recommendations | Reuse existing mechanisms when they fit the requirement. New components, layout changes, and fixes to shared implementations are allowed; configuration alternatives need not each fail first. |
| Exception path | When the default does not fit, state the concrete gap, implementation owner, affected consumers, and verification method, then choose a more direct implementation. An exception does not bypass applicable security or compatibility requirements. |

## Extension point map

| Requirement | Default entry point | When to adjust the implementation |
|---|---|---|
| Feature selection, company defaults, and startup composition | Profiles, bundles, and configuration patches | Add a plugin or change the capability owner when configuration cannot express the required capability. Fix shared defects directly rather than maintaining an overlay workaround. |
| Company name, logo, and welcome area | Brand plugins and sidebar/hero Slots | Add a Slot or adjust the layout when existing positions do not meet the agreed experience. Check build and startup entry points separately for page titles and initial rendering. |
| Primary colors, backgrounds, buttons, and selected states | Theme plugins through `ctx.theme.overrideTokens`; components consume semantic tokens | Extend the theme or shared components when semantics or control capabilities are missing. Keep local layout in the component. Token use alone does not establish that branding is complete. |
| Company identity and sign-out controls | Server-owned identity and sign-out capabilities, presented by client account UI or an appropriate Slot | Choose HTML bootstrap data, forms, or APIs for the actual requirement. Define company and model-provider identities separately; company sign-in does not automatically imply hiding the model account. |
| Business pages, result cards, and action entry points | Client plugins, Slots, and existing primitives | Keep business-specific components in their feature package; place suitable shared controls in the shared component library. New layouts are allowed, and a one-off requirement need not introduce a general extension mechanism. |
| Business capabilities, policies, and coordination | Services, events, and registration APIs | Add an interface or change its implementation when an extension point is missing or its owner has a defect. Plugin-first development does not prohibit changes to core implementations. |

## Basis and exception handling

For routine changes, reuse verified documentation or a reference implementation. Check current source, accompanying documentation, and the corresponding upstream material when first using a mechanism, changing versions, resolving conflicting information, or considering a substantial workaround. Repeated development does not require repeated web searches.

When changing a shared implementation, the following explanation is usually sufficient:

> The scenario is …; the existing entry point lacks …; the proposed change belongs in …; it affects …; verification uses ….

One concrete scenario can justify a change; multiple existing callers are not required. Proceed autonomously with routine implementation. Changes to long-term responsibilities, shared extension mechanisms, or agreed behavior follow existing rules and reuse decisions already made.

## Verification by change scope

Select evidence for the affected behavior using the existing [testing policy](testing.md).

| Change | Evidence |
|---|---|
| Copy | Relevant English and Chinese text, its display, and accessible names |
| Styling or components | Affected states and relevant light/dark themes, narrow layouts, and keyboard interactions |
| Branding or composition | The actual enabled composition and agreed user entry point, covering the pages and states in scope |
| Capabilities or shared mechanisms | Affected consumers, failure paths, and relevant lifecycle behavior |

Report source implementation, build results, deployment, and user-entry verification separately. Reuse existing checks and address coverage gaps without adding a duplicate checklist.

The detailed standards remain in [architecture and composition](architecture.md), [client rules](../packages/client/AGENTS.md), [Slots](subsystems/slots.md), and [styling](web-styling.md).
