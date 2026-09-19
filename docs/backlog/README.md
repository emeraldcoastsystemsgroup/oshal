# Backlog (per-area open work)

Focused active-work and handover backlogs for specific areas. The cross-cutting engineering
queue is [../BACKLOG.md](../BACKLOG.md). Active entries state only reproducible residual work and
its done-when evidence; resolved history is preserved in the [archive](./archive/README.md), the
relevant ADR or feature documentation, release notes, and git history.

- [session-handover-2026-09-17.md](./session-handover-2026-09-17.md) — where the overnight run stopped: tree state, the two workflows that were stopped mid-flight, the five open PRs, and the unresolved reason an ordinary user is granted `@app-admin`.
- [triage-2026-09-15.md](./triage-2026-09-15.md) — **read this before triaging the backlog again.** Every entry in `docs/BACKLOG.md` given a verdict against the code: 137 actionable, 75 need the operator, 46 need live proof, 11 blocked, and 14 claimed done-or-stale that an independent verifier refuted and so were kept open. Only one "already done" claim survived two refuting verifiers. Machine-readable, keyed by entry title so it survives line shifts: [triage-2026-09-15.json](./triage-2026-09-15.json).
- [clean-kernel-repair.md](./clean-kernel-repair.md) — the [clean-kernel repair specification](../architecture/clean-kernel/11-repair-spec.md) re-derived against the tree, claim by claim, with a second reader instructed to overturn each verdict. 21 claims: 20 mechanisms located and confirmed in the tree, 1 refuted outright, 7 impacts corrected down and 5 up, plus 4 defects the assessment did not name. 9 items ready to ship, 8 blocked on an operator decision. Read the corrections section first — the assessment's tables are what a planner would size against, and its R0 estimate does not survive.
- [outstanding-work-index-2026-09-14.md](./outstanding-work-index-2026-09-14.md) — a map, not a
  queue: every document across this repo and `oshal-applications` that records unfinished work, with
  its counted open-item total, item shape, blocked-or-ready call and last-updated date; plus the
  stale and contradictory claims found while indexing (nine documents still describe core PR #431 or
  store PR #185 as open) and a prioritised "ready to pick up now" list.
- [antigravity-and-node-footprint.md](./antigravity-and-node-footprint.md) — **enhancement, nothing is broken**: turning the registered-but-blocked Antigravity CLI harness into a working one, and the larger question it exposed. Google ships no musl build (manifest 404; the glibc binary fails to relocate under gcompat), so it is a base-image decision. Carries the measured footprint (7.05 GB image, 1.2 GB global node_modules, ~1.08 GB of it four CLI harnesses every bot container carries whether it uses them or not), the three delivery shapes the operator named (fatter base / dynamic load-unload / shared mount), and the finding that `agy` supports an SSH device-code account login — which may ride an entitlement rather than the API key's quota.
- [hardening.md](./hardening.md) — security hardening backlog.
- [artifact-exchange-continuation.md](./artifact-exchange-continuation.md) — ADR-139 "Send to…": what
  shipped, what was half-landed at handover (both halves since merged and deployed), how to continue
  the rollout, and three recurrence risks the rollout exposed (hardcoded codex model default, no
  backoff on a dead model, no guard for dated-test time bombs).
- [test-lab.md](./test-lab.md) — AI Test Lab backlog (ADR-063).
- [trading-advisor.md](./trading-advisor.md) — trading advisor backlog.
- [bot-ui-db-persistence.md](./bot-ui-db-persistence.md) — Bot UI DB persistence (Option B).
- [haven-deferred-properties.md](./haven-deferred-properties.md) — the ADR-030 persona properties
  and the ADR-079 deferred list: what closed (push proactivity, connector-signal facts, compaction)
  and what is still open (conversational onboarding, persona-wrapping of specialist replies).
- [jarvis-voice-and-visuals.md](./jarvis-voice-and-visuals.md) — Jarvis typed visual responses,
  ambient voice UX, selectable/private TTS, live-provider acceptance, native transcript boundaries,
  and safe next-step expansion.
- [capture-crm-plugin-open-work.md](./capture-crm-plugin-open-work.md) — **superseded** June 2026
  handover for the Capture CRM plugin that framed an external `:8787` board; kept as history. The
  current record is [government-contracting-crm.md](./government-contracting-crm.md).
- [government-contracting-crm.md](./government-contracting-crm.md) — relationships, capture and
  contract management requested for the government-contracting site.
- [education-content-sources.md](./education-content-sources.md) — education content sources and
  search.
- [lm-class-config-open-work.md](./lm-class-config-open-work.md) — Little Monsters class
  configuration, open work / handover.
- [lm-feature-backlog.md](./lm-feature-backlog.md) — Little Monsters feature backlog.
- [non-human-checklist.md](./non-human-checklist.md) — machine-doable burn-down tracker with
  done-when criteria and human-only exclusions.
- [store-dependency-tier-migration.md](./store-dependency-tier-migration.md) - converting the
  store's packages to the ADR-085 `required` / `optional` dependency tiers: sequencing behind the
  core deploy, the per-package classification and its evidence, and the gaps it surfaced.
- [next-priorities.md](./next-priorities.md) — the operator's 2026-09-11 "next ten autonomous
  priorities": a ranked table of outcomes, each with its autonomous acceptance and status.
- [app-test-lab-registration.md](./app-test-lab-registration.md) — installed applications' test
  cases in the AI Test Lab: versioned package catalogs, the installation lifecycle, isolated package
  execution, the browser-runner follow-up and the runner handover.
- [enterprise-authorization.md](./enterprise-authorization.md) — ADR-149 enterprise application
  authorization: the AUTH work orders, what the core foundation implements, and the enterprise
  adoption still open.
- [cockpit-startup-resilience.md](./cockpit-startup-resilience.md) — cockpit startup: the
  local-asset startup slice and the still-open rollout-time database checkout investigation.
- [cockpit-workspace-navigation.md](./cockpit-workspace-navigation.md) — the cockpit workspace
  navigation overlay and Workspace skin, the compact Home/Jarvis presentation, and the remaining
  briefing producers and context actions.
- [jarvis-daily-dashboard.md](./jarvis-daily-dashboard.md) — Jarvis and the daily dashboard: the
  compact presentation, and recorded-report producer adoption with its pending publication and
  delivery acceptance.
- [service-auth-smokes-unexercised.md](./service-auth-smokes-unexercised.md) — a service-auth
  smoke with no bound operator transport reports PENDING, so the installer's postflight now
  exercises none of them and still exits 0. The narrowing was right; the gap needs a name.
- [archive/](./archive/README.md) — dated snapshots of verified-resolved queue entries; these are
  searchable implementation history, not active work.
