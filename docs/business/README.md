# Business, GTM & competitive

Positioning, go-to-market, and pitch material. The engineering-facing "why OSHAL" case lives at
[../WHY_OSHAL.md](../WHY_OSHAL.md); the whitepaper at
[../OSHAL-WHITEPAPER.md](../OSHAL-WHITEPAPER.md).

- [catch-up-plan.md](./catch-up-plan.md) — grassroots plan to reach competitor parity on
  "the glue" (replaces the earlier go-to-market plan; OSHAL is OSS freeware, not for sale).
- [marketing-engine-spec.md](./marketing-engine-spec.md) — **specification** for the automated
  marketing engine: two motions (core adoption, commercial-app revenue), bot roster + reused
  rails, services/keys, measurement + funnel, cadence, budget governance, targeting and pricing
  method, phased done-when plan.
- [marketing-engine-runbook.md](./marketing-engine-runbook.md) — **operator runbook** for the
  built engine (ADR-131/132/133): morning account-creation checklist, the approval loop
  (channels consent, tickets, budget proposals), what's deliberately staged, troubleshooting.
- [marketing-suite-market-research.md](./marketing-suite-market-research.md) — **research (read
  2026-09-13)** behind the marketing suite spec: comparable all-in-one, email, SMS, social and
  analytics products with free-tier and entry prices (sourced, ±30% bands, unverified figures
  marked), the self-hostable open-source stack, and the email/SMS compliance rules (CAN-SPAM,
  GDPR/ePrivacy, CASL, Gmail/Yahoo bulk-sender, RFC 8058, TCPA, CTIA).
- [competitive-landscape.md](./competitive-landscape.md) — competitive landscape.
- [competitive-claims-honest.md](./competitive-claims-honest.md) — **the
  adversarially-verified record of which claims survive.** Two "exclusive" claims (runtime agent spawn,
  agent cluster per step) were refuted and retired; documents what's real in our own code (the
  self-healing red/blue loop) so nobody re-confuses it in either direction. If the site and this file
  disagree, this file wins.
- [native-kernel-publication.md](./native-kernel-publication.md) — publication-ready write-up of the
  "should we rewrite it in a compiled language?" question. **Posture: measured, one machine, one
  subsystem** — the control plane is I/O-bound so compiling it buys ~nothing, while one 900-line
  numeric layer gave 5-7x bit-exact. Stated limits are on the page, not in footnotes. Engineering
  detail: [../architecture/native-compiled-kernel.md](../architecture/native-compiled-kernel.md);
  deck: [../assets/oshal/native-kernel-deck.pptx](../assets/oshal/native-kernel-deck.pptx).
- [oshal-capabilities-brief.md](./oshal-capabilities-brief.md) — capabilities brief.
- [oshal-as-is-to-be-delivery.md](./oshal-as-is-to-be-delivery.md) — as-is / to-be state and
  delivery plan.

Related: [../assets/oshal/README.md](../assets/oshal/README.md) — one-pager, benchmark brief,
demo script, sales deck outline, messaging kit. [../enterprise/](../enterprise/) — procurement
security packet, permission-aware RAG, SCIM bridge. [../saas/](../saas/) — public self-serve
foundation.
