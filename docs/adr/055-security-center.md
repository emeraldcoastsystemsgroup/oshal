# ADR-055 — Security Center: the swarm's self-security app

- **Status:** Accepted — implemented (reconciled 2026-07-31) as the `security` kernel app: `swarm-apps/security.yaml` (Security Center — deterministic scanners on the controller, reasoning on the inline security-analyst bot) + `src/features/security/`; scope as decided — observe + triage + escalate-to-ticket, no auto-remediation
- **Date:** 2026-06-19
- **Related:** [ADR-036 (bot-owned application architecture / cost split)](036-bot-owned-application-architecture.md),
  [ADR-052 (stock-trading swarm)](052-stock-trading-swarm.md),
  [2026-04-20 (swarm application manifests)](033b-swarm-application-manifests.md)

## Context

OSHAL runs many bots that touch real assets: credentials in config and env, money-moving ledgers
(trading, payments, shop), per-user data, and an LLM cost surface that an abusive or injected input
can run up. The platform had **no app that watches its own security posture or runtime**. The
operator has already hit the failure modes this is meant to catch — credentials committed in
plaintext to a manifest, a Pages deploy that published server source, and PII leaked into a public
repo — so the need is concrete, not theoretical.

We want one place to answer: *what is exposed, what is behaving anomalously, and what should I do
about it* — without bolting a new subsystem onto the core. The swarm-app manifest pattern already
gives us bots + routes + a cockpit surface + ticket routing declaratively, so a Security Center
should be **just another app**, not a fork of the platform.

## Decision

Ship a `security-center` swarm app covering five scopes (four at inception; `image` added 2026-07-10):

- **Posture (active scan)** — three filesystem collectors over the repo working tree:
  committed/present **secrets** (regex signatures, git-tracked = escalated, examples de-escalated,
  values redacted — never stored), **unauthenticated routes** (parse the server mount table, flag
  `/api/*` mounts missing `requiresAuth`, minus a public-by-design allow-list), and **vulnerable
  dependencies** (`npm audit --json`, degrades honestly when offline).
- **Runtime threat detection** — heuristics over `chat_tasks`: failed-task spikes, unusually
  expensive single runs, and per-agent activity bursts.
- **Ledger / money anomalies** — owner-scoped reads of `oshal_trading_orders` + `shop_purchase_history`:
  orders with no justifying decision (the ADR-052 invariant), large-notional orders, reject spikes,
  large purchases.
- **Access / audit** — dispatch-trail anomalies over `routing_audit_log` (no-candidate / low-fit
  routes). Richer per-resource access auditing needs owning-app instrumentation; that gap is noted
  rather than papered over.
- **Image / supply-chain (Trivy)** — *added 2026-07-10; see Addendum.* one offline `trivy fs` pass
  over the platform's own tree covering OS/library **CVEs**, IaC/Dockerfile/compose **misconfiguration**,
  and embedded **secrets**. Built air-gap/FIPS-first (no scan-time internet).

**The ADR-036 split applies.** The controller runs the deterministic scanners and stores each hit in
`oshal_security_findings`, keyed by a stable `fingerprint` so a re-scan refreshes in place and
**preserves operator triage** (an `ignored`/`resolved` finding is never silently reopened). The
accountable **security-analyst** bot — reason-only, inline on the api container — triages one finding
at a time into a structured verdict (`isRealThreat` / `falsePositive` / calibrated severity / attack
scenario / smallest fix / `needsHistoryScrub`), so its cost lands in `chat_tasks` under its own
agent_id. A triaged finding escalates to a `security-finding` ticket, linking `finding_id ↔ ticket_id`.

**Scope boundary:** observe → triage → escalate. The app does **not** auto-remediate — no key
rotation, no code edits, no auto-closing findings. The operator acts on the assessment.

## Consequences

- Scanners are pure collectors (`ScannerReport`); adding a new check is one file + one line in
  `runScan`. DB detectors guard on table existence and degrade to an honest "unavailable" note —
  coverage is never silently dropped to zero.
- Secret findings keep only a redacted preview and a `committed` flag; the live value is never
  persisted. A confirmed leak's recommended fix includes scrubbing git history, not just deleting
  from HEAD (the [[oshal-committed-secrets]] / [[deals-repo-pii-incident]] lesson).
- The bot's triage is advisory and best-effort-parsed; a malformed response falls back to the
  scanner's own severity rather than failing the request.
- Posture scanning reads the repo working tree (`SECURITY_SCAN_ROOT`, default cwd), so it reflects
  what is on disk in the api container, not necessarily git HEAD.

## Files

- `swarm-apps/security.yaml` — the manifest (bot + route + migration + cockpit surface)
- `ai-lab/bot-personas/security-analyst.yaml` — the reason-only triage bot
- `src/features/security/` — the scanners + orchestrator (`runScan`): `secret-scanner`, `route-audit`,
  `dependency-scanner`, `threat-detector`, `ledger-monitor`, `audit-trail`, and `trivy-scanner`
- `src/app/routes/security-routes.ts` — scan / findings / assess / ticket (mounted at `/api/security`)
- `src/api/security.html` — the cockpit surface
- `scripts/migrations/039-security-center.sql` — `oshal_security_scans` + `oshal_security_findings`

## Addendum — 2026-07-10: `image` scope (Trivy), air-gap / FIPS 140-3 / IL6

A fifth scan scope, `image`, adds **Trivy** as a first-class scanner in the same `runScan()` fan-out
(pure `ScannerReport` collector — the "one file + one line" extension the Consequences section
promised). It runs a single offline `trivy fs` pass over the platform's own tree, covering three
supply-chain surfaces at once: OS/library **CVEs** (`trivy_vuln`), IaC/Dockerfile/compose
**misconfiguration** (`trivy_misconfig`), and embedded **secrets** (`trivy_secret`). Findings upsert
into `oshal_security_findings` with those Trivy-scoped categories (kept distinct from the posture
categories so stale-finding reconciliation only auto-resolves Trivy findings on a run where Trivy
ran). Unlike the other scanners, `image` findings at/above `TRIVY_TICKET_SEVERITY_FLOOR` (default
`high`) **auto-file** into the Security Center queue **backlog** as `security-finding` tickets — the
operator gets a queue of the important issues without opening each one.

Built for a disconnected enclave (the reason it exists):

- **No scan-time egress.** Always `--skip-db-update --skip-java-db-update --offline-scan`. The vuln DB
  is provisioned out of band (a mounted `--cache-dir`, or an internal OCI registry via
  `TRIVY_DB_REPOSITORY`); refreshing it is a deliberate connected step, never part of a scan. Asserted
  by `tests/unit/security-trivy-scanner.spec.ts`.
- **Least privilege.** `trivy fs`, not `trivy image` — no docker socket, no elevated privilege.
- **Fail-closed.** Missing binary / unseeded DB ⇒ `available:false` with a note, never a silent clean bill.
- **Secret redaction.** Only rule id + location are stored; the matched value and code line are dropped
  (consistent with the secret-scanner's never-store-the-value rule).
- **FIPS.** `Dockerfile.oshal` bakes a pinned, overridable Trivy (`--build-arg TRIVY_VERSION` /
  `TRIVY_INSTALL_URL`) so the enclave substitutes its accredited FIPS build with no code change.

Also fixed in the same change: `POST /findings/:id/ticket` was passing finding data in a top-level
`payload` field that `CreateInternalTicketSchema` silently strips — it now rides in `metadata`.

Files added: `src/features/security/trivy-scanner.ts`, `tests/unit/security-trivy-scanner.spec.ts`,
`docs/runbooks/trivy-airgap-security-scanner.md` (the air-gap DB-seeding + FIPS-swap runbook).
