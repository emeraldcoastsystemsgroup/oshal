<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the full plan to migrate the legacy job-hunter Flask dashboard into native OSHAL surfaces + tools + hive, retiring the proxy.
-->

# Career Hunter — Native Migration Plan

> **Status — 2026-06-17: Phases 1–6 SHIPPED** (commits `952ab5e`→`c875d78`). Native tabs live:
> Job Board (full filters/sort/salary/posted/P-land), Job detail + actions, Recruiters,
> Strengthen (talk-to-strengthen-resume), Insights (funnel + distributions), guidance-tailored
> generate, and the career-advisor bot drives it all. Validated on real data; api stable.
> **Remaining (connector-dependent follow-ons):** Dropbox resume-save (needs the Dropbox
> connector wired to a save action), LinkedIn job-feed connector, a Firecrawl recruiter-find
> route. Email + social recruiter awareness already lives in the advisor.

**Goal:** retire the proxied legacy Flask dashboard ("Classic dashboard") and rebuild **100% of its functionality** as native OSHAL surfaces + bot tools, architected for the swarm (multi-tenant-ready data, Dropbox storage, and the hive: social bot, email bot, LinkedIn). The operator keeps using the historic/proxied board until each native view reaches parity, then we retire the proxy view-by-view.

## Architecture (ADR-036 — bot owns the domain, surface is a view)

- **The career-advisor bot owns the domain.** It reasons over the data and calls *tools* (the engine verbs) to act. Surfaces are read/act views over the data; reasoning runs on the bot (cost + settings apply).
- **Data model (multi-user now, multi-tenant ready):**
  - *Engine store* — the per-user SQLite the engine reads/writes: shared `corpus.db` (companies + objective `postings_corpus`) + per-user `user-<sub>.db` (signals, status, resume/cover paths, recruiters, interview bank), under the **`api-output` volume** at `career-hunter-data/<tenant>/<sub>/`. Already isolated per user; **`<tenant>` is threaded everywhere** (the `TENANT` constant) so multi-tenant is a config flip, not a rewrite.
  - *OSHAL-layer state* — Postgres `career_hunter_applications` (the approval queue), already keyed `(tenant_id, user_sub)`. All new state follows the same key.
  - Native routes read the engine SQLite via `openUserDb` (corpus ATTACHed), scoped to the signed-in `user_sub`. Writes go to `user-<sub>.db` (per-user) or Postgres (cross-cutting).
- **Surfaces** — native themed HTML in `any-bot/server/services/tools/career-hunter/`, reading native JSON routes under `/api/career-hunter/*`. No spawned Flask, no proxy, survives restarts.
- **Connectors the app will use (the hive):** Anthropic (resume/cover generation), Firecrawl (scrape), **Dropbox** (save generated resumes to the user-defined folder), the **social bot** (find recruiter touchpoints), the **email bot** (recruiter messages / interview invites / job alerts), **LinkedIn** (job feed + recruiter profiles). Each is a per-user connector token brokered to the bot — never a new app (ADR-038).

## The 26 legacy views → native surfaces

| Legacy route(s) | Native surface / route | Phase |
|---|---|---|
| `/` board (q, min_score, company, remote, status, source, **sort: ai/salary/posted/applied**, salary, landing-prob) | `career-board.html` + `/jobs` (full filters/sort) ✅ basic done | **1** |
| `/job/<id>`, `/job/<id>/<action>` (promote/dismiss/generate/referral) | job-detail surface + `/jobs/:id` + `/jobs/:id/action` | **2** |
| `/recruiters` (+ add/update/delete) | `career-recruiters.html` + `/recruiters` CRUD + hive find | **3** |
| `/strengthen` (+ scan/answer/skip/reopen) — *talk-to-strengthen-resume* | `career-strengthen.html` driven by career-advisor bot | **4** |
| `/insights`, `/report`, `/ready`, `/progress`, `/map`, `/companies` (+seturl/referral), `/sources`, `/skills` (+assess/finalize) | analytics surfaces + read routes | **5** |
| `/file`, `/resume-file` | `/resume` ✅ done | 1 |

## Bot tools (the career-advisor's hands — ADR-036)

Wrap the engine verbs as tools the bot calls + reasons with: `pull` (cron), `score/index`, `reset-criteria` (change scoring inputs), `draft`, and **`tailor-resume` / `special-cover`** — the one-off "make this cover more about my early career" (extend `generate.py` to accept custom instructions). The bot identifies what the operator is working on and modifies it.

## Phases + testable milestones

- **Phase 1 — Board parity** *(testable: the board does everything the historic board's main list does)*: port the engine's filter/sort SQL into `/jobs` (q/min_score/company/remote/status/source + sort ai/salary/posted/applied), add salary + posted-date + landing-probability to the surface, sort/filter controls.
- **Phase 2 — Job detail + actions** *(testable: open a job, promote/dismiss/generate from OSHAL)*.
- **Phase 3 — Recruiters** *(testable: see/add/edit recruiters; "find a touchpoint for X" hands off to the social/email bot)*.
- **Phase 4 — Strengthen** *(testable: chat to answer gap questions; resume profile updates)* — the bot-reasoning centerpiece.
- **Phase 5 — Analytics views** *(testable: insights/report/ready/progress/map render natively)*.
- **Phase 6 — Hive + connectors + tools** *(testable: Dropbox save; social/email bot recruiter find; bot tools callable)*.

Each phase: native route(s) + surface, tsc-strict clean, rebuilt + deployed + verified on real data, committed, **operator notified it's testable**. The proxy's "Classic dashboard" link stays until Phase 5 retires it.

## Done-when (the whole migration)
`/cockpit/?app=career-hunter` exposes every legacy capability natively — board with full sort/filter/salary/posted, job detail + actions, recruiters, strengthen, analytics — backed by the per-user (tenant-scoped) store, with Dropbox saves and social/email-bot recruiter collaboration. The proxy is removed. The career-advisor bot reasons over it all and calls the engine verbs as tools.
