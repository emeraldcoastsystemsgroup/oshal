# OSHAL catch-up plan — reach parity on the glue (2026)

> Honest, no-sales framing. OSHAL is solo open-source freeware. We will **not** sell it. The goal is
> to **catch up to the competitors' functionality** on the thing we actually are — **the glue** — and
> get there **grassroots** (OSS + community). Companion to the honest read in
> [competitive-landscape.md](competitive-landscape.md). Replaces the earlier go-to-market doc,
> which was the wrong altitude.

## What "the glue" is

OSHAL isn't trying to out-model Anthropic or out-scale Amazon. What it *is*, and what's worth making
great, is the **glue**: connectors + swarm orchestration + surfaces that tie a person's whole digital
life together, on their own keys and their own box. The competitors have more glue than us because
they're huge and move fast. Catching up = closing the glue gap, not inventing a new category.

## Parity gaps — ranked, with honest status

| # | Gap (vs competitors) | Status | What "caught up" looks like |
|---|---|---|---|
| 1 | **Connector breadth** | 🟢 mostly there — ADR-067 marketplace now lists **1,053** connectors (bulk OpenAPI import + icons). | A handful proven end-to-end with real brokered creds (ADR-067's remaining item), not just cataloged. |
| 2 | **Marquee features actually work** | 🔴 several inline-bot apps (finance/identity/kid-lens/presentations/social) 401 or aren't proven | Signed-in e2e green for each — a logged-in user gets real output, not an error. |
| 3 | **Anyone can actually run it multi-user** | 🟡 RLS code + verifier built, not applied/soaked | RLS on + two-user isolation proof, so a second person can use an instance safely. |
| 4 | **Inherit the MCP ecosystem's glue** | 🟡 MCP works only inside the harness | A server-side MCP path so any MCP server = a connector; we borrow breadth instead of hand-building it. |
| 5 | **"Talk to it" / ambient** (the Alexa-style bit) | 🔴 roadmap (ADR-047 voice + edge) | Optional. Only worth it after 1–4; it's the flashiest but not the foundation. |

**Sequence:** make what exists *actually work and be safe to run* (2, 3), prove the breadth we already
built (1), then borrow more via MCP (4). Voice (5) is a nice-to-have demo, last.

## Grassroots — how people find it (no selling)

Not a sales motion. Just the normal way a good OSS tool spreads:

- **A clean public repo + one-command laptop install + a short demo video.** This is 80% of it.
- **Show it where the self-host crowd already is:** Home Assistant community, r/selfhosted, r/LocalLLaMA,
  a "Show HN," awesome-* lists, the MCP ecosystem. These people are pre-sold on "own your own stuff."
- **The connector marketplace is the community flywheel.** If contributing a connector is easy and the
  license is permissive, other people add breadth for free. (License is a real choice — MIT-style invites
  contribution the way Activepieces does; a restrictive license chills it. Worth deciding before going public.)
- **Honesty as the differentiator:** we can say "your keys, your data, your model, self-hosted" — which
  none of the giants can. That's the whole pitch, and it costs nothing.

## What actually matters for the real goals

Two real goals, plainly:

1. **Catch up** — get the glue to where a self-hoster picks OSHAL over cobbling together five tools.
   That's gaps 1–4 above.
2. **It's a portfolio piece / job signal.** A solo-built, vendor-neutral, multi-harness orchestration
   platform that *actually runs and does real things* is a strong staff/architect-level artifact. The
   thing that lands a job isn't a business plan — it's the working demo + a crisp "here's what I built
   and why it was hard" story. Making gaps 2 and 3 real (features work, it's safe to run) is what turns
   the repo from "impressive-looking" into "impressive-and-demoable."

No revenue targets, no pricing, no segments. Just: better glue, running for real, found grassroots.
