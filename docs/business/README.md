# Business, GTM & competitive

Positioning, go-to-market, and pitch material. The engineering-facing "why OSHAL" case lives at
[../WHY_OSHAL.md](../WHY_OSHAL.md); the whitepaper at
[../OSHAL-WHITEPAPER.md](../OSHAL-WHITEPAPER.md).

- [catch-up-plan.md](./catch-up-plan.md) — grassroots plan to reach competitor parity on
  "the glue" (replaces the earlier go-to-market plan; OSHAL is OSS freeware, not for sale).
- [marketing-engine-spec.md](./marketing-engine-spec.md) — **specification** for the automated
  marketing engine: two motions (core adoption, commercial-app revenue), bot roster + reused
  rails, services/keys, measurement + funnel, cadence, budget governance, targeting and pricing
  method, phased done-when plan. Nothing in it is built unless marked; implementation is held in
  [BACKLOG](../BACKLOG.md).
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
