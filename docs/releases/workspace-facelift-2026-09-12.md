# Shared Workspace appearance and header navigation

The portal palette now follows application navigation, shared embedded pages and
standalone shared pages. Settings offers **Application colors** for users who want
the active application's declared skin. Choosing a portal palette turns that option
off. Workspace is the initial palette when no saved choice exists; valid saved
choices remain intact. See [appearance settings](../apps/appearance.md).

The optional workspace navigation places permitted application links beside the
brand in the desktop header. Phones expose the same destinations through a
Workspaces disclosure. Sidebar remains the default navigation setting. Existing
custom pages, active documents, unsaved content and authorization checks retain
their behavior. The [dashboard prototype](../mockups/cockpit-workspaces.html)
remains a separate design proposal.

Users, Access, Applications, App Loader, Admin, Config Admin and AI Test Lab share
the palette bridge and surface styling, alongside eighteen operations/studio pages
and Jarvis briefing preferences. Visual checks also corrected Run Trace colors,
Queue panels and RAG previews. Standalone chat follows saved palette changes
without saving inherited bot colors. All twelve palettes define native control
schemes and primary accent text colors.

Career Hunter 1.20.0 gives thirteen existing screens consistent typography,
controls and palette tokens while retaining white resume paper and existing
job, profile and application workflows. Create 1.2.2 applies the same palette
contract to Home and New design, including search state and the active document.
Their application skins remain available through Application colors.

## Published sources and verification

- Core [2b0dd4fc](https://github.com/emeraldcoastsystemsgroup/oshal/commit/2b0dd4fcaaa80ddaa120a46692398e31d20ff6ff): 225 appearance cases across six files; 17 later focused shared-finish checks, including Jarvis briefing preferences; 71 existing palette, shared-style and static-route contracts; and 28 header/navigation cases comprising 23 Chromium cases, four model cases and one Lab registration assertion. Typecheck and scoped lint pass. The RAG contrast regression covers Midnight, Daylight and Workspace.
- Career Hunter 1.20.0, [1eecfe1b](https://github.com/emeraldcoastsystemsgroup/oshal-applications/commit/1eecfe1b3a6ca2f7fe17f169e28a0de91c350f13): 18 Chromium checks and 53 affected Node checks pass. The same 53 checks also pass through the catalog-selected sealed runner with verified cleanup. Its eight catalog scenarios retain explicit browser, core-runtime and legacy fixture prerequisites.
- Create 1.2.2, [8d25f6d0](https://github.com/emeraldcoastsystemsgroup/oshal-applications/commit/8d25f6d0f2e59a3f5bddf8e754c558d53e6b9fe5): nine Chromium checks and all twenty existing Node/HTTP checks pass. Its five catalog scenarios preserve the readiness smoke and existing suites, with the new browser recipe declaring its Chromium and core-asset prerequisites.

These are separate verification commands with overlapping coverage, not a combined
test total. The seventeen-check focused command excluded ninety-three tests outside
its selection. Browser fixtures use actual page code with controlled local data;
they do not establish native business-workflow or provider acceptance. Package
catalog validation and scoped lint pass; package compatibility audits remain pending.

## Deployment and native acceptance

The standard immutable stages contain 259 committed Career files plus provenance
and seventeen committed Create files plus provenance. The copy at 16:24:08 UTC on
12 September 2026 verified all **278 of 278** target files against those stages.
No dependency packages were copied and no files were deleted.

The standard core preview rollout for `2b0dd4fc` completed at 16:33:15 UTC on
12 September 2026 with all 35 services healthy and image parity clean. The deployed
image is `sha256:352982b14b76ccfdda9a7073e12f6d0665c53f696afa67b0d8444ccc13ca93ff`.

The final strict preservation comparison passes: both target packages match all
278 staged files, the other 57 installed packages retain their accepted contents,
and infrastructure, configuration, grants, runtime mounts and CRM records/documents
remain consistent with the original baselines. The first comparison exposed a
helper-only fingerprint discrepancy for an existing `.cmd` file. Correcting that
calculation required no runtime or source change; the earlier evidence was retained.

Actual signed-in Chrome checks show the workspace links beside the brand. The header
theme control changed Career from Workspace to Midnight, and the Settings chooser
changed Create from Midnight to Workspace. Enabling Application colors applied
Create's bundled skin while retaining Workspace as the saved portal choice.
These checks exercise the existing
installed screens without provider calls or business mutations.

The authenticated Lab catalog exposes fifteen relevant entries: eight for Career
Hunter 1.20.0, five for Create 1.2.2 and two core appearance/navigation cards. The
core cards link the updated test sources. Through the actual Lab Run control,
Career `screen-contracts` passed all **53 Node tests**, with zero failures or skips
and verified cleanup. Run `bd66ffe0-c64a-4b1d-848e-3a1509319671`, created at
16:40:42 UTC, matches installed Career 1.20.0/source `1eecfe1b` and the deployed image.
The real Cockpit appearance and workspace-navigation readiness controls also pass,
including **33 currently admitted links**. The Lab page itself displays Workspace.
These two readiness checks do not execute the linked browser suites. Earlier
native checkpoints remain recorded separately in the
[preceding release record](parallel-backlog-2026-09-11.md).

During the rolling restart, Home reported unavailable display settings and one
workspace discovery request required Retry. After startup, the same-session
preferences GET returned 200 in 176 ms; fresh Home navigation enabled Customize
and removed the warning, and Retry restored the workspace links. The existing
deadlines remain unchanged. Final native checks restored the original Midnight
palette, retained top workspaces and left Application colors off.
