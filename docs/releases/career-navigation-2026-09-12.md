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
catalog. Linked Chromium recipes and installed Node execution remain distinct.
Source results, exact installed versions, native acceptance and preservation will
be recorded after the standard local preview rollout.
