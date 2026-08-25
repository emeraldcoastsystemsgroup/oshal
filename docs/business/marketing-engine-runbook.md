# marketing engine — operator runbook (the human piece)

> Companion to [marketing-engine-spec.md](marketing-engine-spec.md) and ADR-[131](../adr/131-marketing-engine-package.md)/
> [132](../adr/132-public-site-analytics.md)/[133](../adr/133-outbound-marketing-connectors.md).
> Built overnight 2026-08-23. **Nothing posts, sends, emails, or spends until you complete the
> steps below** — every channel is opt-in default-OFF, every bot run waits on a ticket you
> approve, every budget change waits on your confirm.

## What exists as of this morning

- **Marketing Engine app** in the cockpit (`/cockpit/?app=marketing-engine`): campaign board with
  stage-gated intake, per-channel consent switches, weekly scorecard (honest NO DATA badges),
  experiment registry, budget-proposal approvals, UTM link builder, run ledger. Content Studio and
  LinkedIn Assistant embedded as panes.
- **Four inline bots** (campaign-director, market-analyst, growth-analyst, launch-coordinator) —
  they draft and propose only; publishing and spending always come back to you.
- **Cadence** (already scheduled, safe while unconfigured): daily metrics ingest 06:20 UTC (reads
  only; unconfigured sources recorded as NO DATA), weekly review Monday 12:00 UTC (creates a
  **backlog** ticket — nothing runs until you approve it in the cockpit Tickets view).
- **Publish rails wired**: LinkedIn (existing connect), Mastodon, Bluesky, transactional email
  (Resend), Search Console reads. X/Facebook publishing stays in Switchboard, as before.
- **Site analytics plumbing**: vendor-pluggable, currently OFF (`SITE_ANALYTICS_PROVIDER` unset —
  the site is byte-identical until you set it).

## Morning checklist A — "go time" account creation (~45–60 min total)

Register everything under **maintainer@emeraldcoastsystemsgroup.com**
([partner-app-registration.md](../partner-app-registration.md)). Order = highest value first;
every step is independently skippable.

1. **Site analytics (10 min, free).** Recommended: Cloudflare Web Analytics (site already on CF
   Pages). Dash → Analytics & Logs → Web Analytics → Add site `oshal.ai` → copy the beacon token.
   Then, in the shell you deploy the site from:
   `export SITE_ANALYTICS_PROVIDER=cloudflare SITE_ANALYTICS_TOKEN=<token>` and run
   `bash scripts/deploy-oswarm-site.sh`. (Plausible/PostHog work the same way — see ADR-132.)
2. **Google reconnect for Search Console (5 min, free).** `.env` now needs the added scope (line
   below); verify the site property exists at search.google.com/search-console (add `oshal.ai` via
   DNS TXT if absent). Then in the cockpit → Connectors → Google → **Reconnect** (existing tokens
   don't gain scopes). Scorecard SEO rows populate on the next ingest.
   `.env`: `GOOGLE_CONNECT_SCOPES` = default list + `https://www.googleapis.com/auth/webmasters.readonly`
   (exact line printed at the end of the deploy notes; applies at next api recreate).
3. **Bluesky (5 min, free).** Create the account (bsky.app) for the oshal/builder identity →
   Settings → App Passwords → create one → cockpit Connectors → Bluesky card → paste
   `handle.bsky.social` as the identifier/email field and the app password as the token.
4. **Resend (10 min, free tier 3k emails/mo).** resend.com → sign up → add + DNS-verify the sending
   domain (SPF/DKIM records it shows you; use a subdomain like `mail.oshal.ai`) → create API key →
   paste on the Resend connector card. Set the sender: `.env` `MARKETING_EMAIL_FROM=oshal <hello@mail.oshal.ai>`.
5. **Mastodon (5 min, free, optional).** The deployment posts to one instance
   (`MASTODON_BASE_URL`, default mastodon.social): create the account there and connect it via the
   existing Mastodon connector card (OAuth).
6. **GitHub traffic (2 min).** `.env` `GITHUB_TRAFFIC_TOKEN=<PAT with repo read>` (or leave the
   existing dev-repo token to be picked up; unset = NO DATA, never an error).
7. **Start the long-lead applications now (they're used in P3, approval takes weeks):**
   Meta app review for the Marketing API (developers.facebook.com, business verification), and —
   only when you decide to fund paid search — the Google Ads API Basic developer token
   (API Center in a Google Ads manager account, ~5 business days). Nothing in the box calls these
   yet; applying early just removes the wait later.

## Morning checklist B — operating the approval loop (no accounts needed)

1. **Open the app**: `/cockpit/?app=marketing-engine` → Board tab → **New campaign** (or Import —
   imports carry content only and can never switch anything on).
2. **Arm a channel** (per channel, deliberate): Channels tab → toggle **Enabled** and set a
   **daily cap ≥ 1** (cap 0 means "never" — the default). That permits *manual, per-item*
   publishes only — and each publish still shows you the exact text and asks for an explicit
   confirm. Standing authorization is a separate switch that demands a daily cap and its
   own confirm — and in v0.1 it arms **nothing**: no autonomous posting path ships yet, the switch
   just records pre-capped intent for when that scheduler lands. Leave it OFF until you trust the
   drafts.
3. **Work the loop**: Board → a campaign → **Research** (market-analyst fills the ICP card) →
   **Draft** (campaign-director writes channel copy) → review/edit → **Publish** (confirm dialog)
   → run ledger records it. Launch checklists come from the launch-coordinator and are always
   human-posted (HN/Reddit/Product Hunt norms — the bot will remind you).
4. **Weekly rhythm**: Monday's review ticket appears in Tickets (badge on the ribbon;
   Telegram note if notifications are configured). Open it → set **Approved** → campaign-director
   writes the review with proposals → Approvals tab → approve/reject each budget proposal
   (approve requires confirm). Ignoring the ticket costs nothing — it just waits.
5. **Read the scorecard honestly**: NO DATA badges mean a source isn't configured or broke — the
   number is absent, not zero. Steps A2 (Search Console) and A6 (GitHub traffic) turn their rows
   green. Step A1's site analytics live in the vendor's own dashboard for now — the PostHog
   connector currently exposes no bounded stats resource the ingest can honestly read, so the
   scorecard's site-traffic row stays NO DATA until that lands (tracked in BACKLOG).

## What's deliberately NOT running (and how it turns on later)

| Staged item | Turns on when |
|---|---|
| Paid ads (Google/Bing/Meta/Reddit) + ads-operator bot | P3 gates: a paid product live, conversion tracking proven, budget tier set — then the Google Ads Basic token from step A7 gets wired per ADR-133's pattern |
| X posting from the engine | you enable X pay-per-use API billing (~$0.015/post, ~$0.20 with a link) — until then Switchboard/manual |
| Instagram/Threads | unbound in Switchboard (honest `skipped`), not planned for the dev audience |
| Standing autonomous posting | per-channel switch + daily cap + your confirm, after draft quality earns it |
| Waitlist capture on the static site | needs a public endpoint decision (ESP-hosted form vs CF Pages function) — BACKLOG |

## Verification & troubleshooting

- Package health: `bash scripts/oshal-verify.sh --apps marketing-engine` (service-auth smoke).
- Drift check: `bash scripts/app-store-drift-check.sh`.
- "not_connected" on publish → that channel's connector card isn't connected for **your** user.
- "no_hosted_brain" on draft/research → Settings → AI Providers (the inline bots ride your
  hosted/BYO brain, same as the career bot).
- "channel_unavailable" for Mastodon → core connector spec missing the action (core deploy drift).
- Weekly ticket didn't appear → `ENABLE_AGENT_SCHEDULER=true` must be set (it is, in compose) and
  the api must have been up Monday 12:00 UTC; trigger it any time from a shell:
  `curl -X POST http://localhost:35457/api/marketing-ops/weekly -H "x-service-secret: $SWARM_SERVICE_SECRET"`.
- Every outward attempt (including refusals) is in the Channels tab run ledger — if it isn't
  there, it didn't happen through the engine.
