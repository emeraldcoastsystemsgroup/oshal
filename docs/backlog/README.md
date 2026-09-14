# Backlog (per-area open work)

Focused active-work and handover backlogs for specific areas. The cross-cutting engineering
queue is [../BACKLOG.md](../BACKLOG.md). Active entries state only reproducible residual work and
its done-when evidence; resolved history is preserved in the [archive](./archive/README.md), the
relevant ADR or feature documentation, release notes, and git history.

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
- [archive/](./archive/README.md) — dated snapshots of verified-resolved queue entries; these are
  searchable implementation history, not active work.
