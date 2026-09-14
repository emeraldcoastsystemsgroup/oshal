# Reuse application capabilities and UI components

Applications should compose working capabilities. Routine user requests supply
data, parameters and edits to versioned tools; they should not require an agent to
generate another renderer, integration client or page implementation.

Before adding code, inspect the installed application's capability/tool catalog,
the [kernel skill registry](kernel-skills.md), and the components below. Use the
owning tool or supported public module. Add new code when the required capability
is missing, then keep that implementation and its tests available to later callers.

## Current building blocks

| Need | Reuse | Contract |
| --- | --- | --- |
| Consistent pages and dialogs | [Portal appearance](appearance.md) and shared surface theme/bootstrap | Read semantic palette tokens and inherit the portal chooser; keep existing navigation and account handlers. |
| Charts, tables, maps, galleries and downloads in responses | [Standard response registry](../../src/shared/ui/response-renderer/components/standard-registry.ts) | Registered typed blocks validate and render through one pipeline, with visible safe fallbacks. |
| Interactive STL mesh preview | `/shared/ui/js/stl-viewer.js` | `OSHALStlViewer.apiVersion === 1`; `parseStl(buffer)` and `mount(canvas)` share one implementation. Scan and CAD keep thin adapters for their existing names. |
| Editable solid CAD and STEP export | [CAD Studio](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/cad-studio) | Read `/api/cad-studio/capabilities`; route-backed tools update the stored base and ordered features through the package's existing kernel bridge. |
| Scan reconstruction and spatial scenes | Scan to Print; the registered `spatial-mapping` kernel skill | Reuse the owning reconstruction and artifact contracts. An STL mesh viewer is not a solid-modeling or physics engine. |
| Results on Home and in Jarvis | [Home integrations](app-home-integrations.md) and [briefing sources](jarvis-briefings.md) | Owning packages provide completed results and supported actions; core composes them with current-user permissions and preferences. |
| Moving files between studios | [Artifact exchange](artifact-exchange-coverage.md) | Registered sources and receivers exchange owner-scoped artifacts with provenance and current authorization. |
| AI operations inside an application | [Package tools](package-tools.md) | UI, Jarvis and supported MCP clients invoke the same registered action and validation. |

## Shared mesh viewer

Load the shared script before the application's adapter and business script. The
adapter checks API version 1 and reports a missing or incompatible core component
explicitly. It does not carry another copy of the renderer. Install the updated
core before package versions that require this asset.

The component consumes an STL buffer. `mount(canvas)` returns `load(buffer)`,
`clear()`, `resize()` and `dispose()`; dispose before replacing the canvas to
release its animation callback, event listeners and GL resources. Nonfinite mesh
coordinates are refused, and very large previews use a bounded coarse grid.
The application remains responsible for
fetching an authorized current artifact and deciding when it may replace the
canvas. In particular, switching records or editing a scan while a request is
pending must retire that request's result before any CAD handoff or redraw.
Viewer success does not establish that reconstruction or CAD generation succeeded.

The shared browser regression exercises real WebGL and both package adapters;
AI Test Lab links that executable suite separately from its fixed-asset readiness
probe. Package HTTP, reconstruction and CAD-kernel tests retain their own scope.

## Keep new integrations reusable

Give a capability one owner, a bounded input/output contract and a version.
Declare its tools, required kernel skills, supported artifacts and application
permissions in the existing manifests. Keep business logic in the owning package.
When two actual consumers need the same UI implementation, extract the common
component and test both adapters; preserve application-specific state and actions.

Retain regression guards when integrating newer releases. A newer feature version
must not discard previously tested identity, freshness or rendering fixes. Register
new executable tests with AI Test Lab, and distinguish source proof, installed
readiness and a completed user workflow in the release record.
