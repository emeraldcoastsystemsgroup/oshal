# Career workspace and contextual navigation — 12 September 2026

Top workspace navigation now includes the existing Federal CRM application when
the current user can open it. The default Home sidebar omits repeated Learning,
Career and Create pages only while their complete workspaces are admitted on top.
Explicit profile metadata drives this presentation. Focused applications keep
their internal navigation; Sidebar layout and unavailable discovery restore the
default entries. An open delegated page and its document stay reachable.

Unique pages remain: Camera Ops, Forge, Workflow Studio and Pumpkin are under
Tools; the source Capture Board and Formation Plan are under Federal source tools.
Federal CRM remains the integrated leads, opportunities, proposals and contracts
application at `/cockpit/?app=capture-crm`. This change does not copy or import data.

Career Hunter 1.21.0 gives Job Board and Open jobs search a shared header and direct
links. Job cards and filters have a clearer hierarchy, desktop submission tools
collapse, and mobile search filters no longer precede every result in a long form.
Worker readiness remains visible. Initial loads show progress; stalled requests
stop with an explicit Retry, and failed requests are distinct from no matches.
Retries require a click and use the current filters. Existing submission and
ownership checks remain in their original handlers.

Intelligent Career 1.0.1 borrows Recruiters, Approvals and Insights from its member,
so its full workspace covers the six Career pages delegated by the global sidebar.
Groups still require active members. The top tab uses the existing Career Hunter
fallback when the group is unavailable; this release does not activate dependencies.

## Verification and installation

The complete navigation command passes 135 cases across six files, including ten
new actual Chromium contextual-sidebar cases and two model cases. Existing Ribbon
guards pass 30/30. The original browser suite and both navigation stylesheets are
unchanged. Core type checking and scoped root lint pass; new and changed functions
meet the fifty-line rule. RibbonNav's untouched platform catalog method remains
the existing 103-line lint exception, with its body verified unchanged.

Career passes 90 cases: nineteen new actual Chromium cases, eighteen retained
palette cases and 53 script contracts. Before/after cases reproduce the absent
search entry, mobile filter crowding and blank initial load. HTTP refusal, stalled
read, explicit Retry, valid empty data and stale responses have separate coverage.
The group passes two public manifest checks and five real core integration cases;
the 23 existing group guards also pass. Scoped types, lint, catalog consistency
and independent source reviews pass.

The new contextual browser suite is part of `npm run test:workspace-navigation`
and linked by the existing AI Test Lab navigation card. Real Career group
resolution and setup checks are linked there too; their actual-manifest fixture
requires the public store checkout or `OSHAL_PUBLIC_STORE_ROOT`. A missing default
checkout is an explicit skip, while an invalid explicit fixture fails.

Career registers its real Job Board/search browser recipe in its versioned package
catalog. The installed Lab exposes all nine package cases plus generated readiness.
Chromium recipes remain unavailable in the installed runner and passed locally;
this is separate from installed Node execution.

The standard local preview deployment completed at 18:47:26 UTC with core
`c1be9d5d5add9cd1fd2dafdf0d0a7965129977f6`, image
`sha256:fda5d8a2cdde0bf57590a5ec7514232371e1eed0026567dcebd4b0d859667c42`,
all 35 application containers healthy and clean deployment parity. Career 1.21.0
and group 1.0.1 were staged from published public commit
`3395b937571a2c35ea50667d4edb96e6a58664d9`; all 266 installed files, including
provenance stamps, match exactly. Resolver dependencies were retained in staging.

Signed-in native acceptance verified the default sidebar omissions, focused
Learning/Create menus, the Career fallback destination and the Federal CRM tab.
The Board retained its original filters and loaded 80 jobs; its new link opened
the separate 50-result Open jobs search, whose Board link returned correctly.
Federal CRM opened its existing home with 33 intake leads, 53 imported opportunity
drafts and 21 no-bid histories. The serving navigation and Ribbon assets match
their published source hashes. Daylight, Workspace navigation and disabled
Application colors were preserved.

The native Lab Run control executed Career's `screen-contracts` case on the
installed 1.21.0 package. Run `4002439d-a966-401a-9632-7a83fa663c7b`, created at
18:53:34 UTC, passed all 53 Node checks with verified disposable-container
cleanup. Its durable result names the exact public source and serving image above.

The strict preservation report remains failed solely because another session
installed Scan-to-Print 0.2.0 during the rollout. A separate read-only review
matched all 83 published files plus its stamp against public commit `5cb27397`
and the owning session's recorded deployment. No strict report or historical
baseline was rewritten. The remaining 56 unrelated packages, 14 infrastructure
identities, configuration, authorization revision 77 / 71 assignments, and CRM
fingerprints (107 records, 512 documents, 37 import checks) remain unchanged.
This review verifies the concurrent package's provenance, not its camera workflow.

Two startup problems were observed and recovered: a parser stalled at an external
head script, and pool checkout delays during fleet recreation. Native Retry
restored navigation and Board data. These remain open in the
[startup resilience backlog](../backlog/cockpit-startup-resilience.md); this release
does not claim to fix them.

Operator-local evidence is retained under `temp/career-navigation-*`: deployment
log and exit status, immutable stage/copy receipts, native page/catalog and Lab
results, the original strict preservation report, and its separate concurrent
Scan-to-Print review. Native screenshots use `temp/workspace-polish-native-*-c1be9d5d.png`.
Documentation-only publication follows this installed checkpoint. No GitHub
Actions, business-data imports or permission changes were performed by this work.
