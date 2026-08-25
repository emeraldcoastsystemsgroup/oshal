# ADR-132: Public-site analytics are config-injected, vendor-pluggable, default none

Status: Accepted (2026-08-23) — overnight decision recorded for operator review; companion to
[ADR-131](131-marketing-engine-package.md).

## Context

The marketing spec's P0 finding: the public site (oshal.ai / oswarm.ai, Cloudflare Pages) ships
**zero analytics** — no visit counts, no referrers, no conversion signal, so every campaign
decision would be blind. The site is generated (`scripts/site-product-pages.js` +
`scripts/lib/product-site/`, nightly lab report) and deployed from the working tree by
`scripts/deploy-oswarm-site.sh`; edits to generated artifacts are overwritten, so any snippet must
live in the **templates**. The operator was asleep; a vendor could not be confirmed, and TTS-style
vendor lock-in is against house rules ("pluggable, siblings behind an interface").

## Decision

One shared snippet builder (`scripts/lib/product-site/analytics.js`) reads environment at
**generation/deploy time** and emits at most one script tag into every page head (generated pages,
the lab report template, and the hand-written root page at its deploy staging step):

- `SITE_ANALYTICS_PROVIDER` = `none` (default) | `cloudflare` | `plausible` | `posthog`
- `SITE_ANALYTICS_TOKEN` (cloudflare beacon token / posthog project key),
  `SITE_ANALYTICS_DOMAIN` (plausible `data-domain`, default `oshal.ai`),
  `SITE_ANALYTICS_HOST` (self-hosted plausible / posthog host override)

Unset or incomplete config emits **nothing** (warn, never fail the build): the site stays exactly
as it is today until the operator creates an account and sets two env vars. All three vendors are
cookieless-capable, consent-banner-free configurations; no PII is collected.

Vendor recommendation (not hardcoded): start with **Cloudflare Web Analytics** (the site already
runs on Cloudflare Pages — zero new infrastructure, free), move to self-hosted Plausible CE if
deeper funnels are wanted later. PostHog is supported for product-event convergence.

## Consequences

- Morning task is: create one analytics account, export two env vars, run
  `bash scripts/deploy-oswarm-site.sh`. Rollback is unsetting the env and redeploying.
- The generator remains the single source of page truth; no per-page snippets to drift.
- Choosing `none` forever remains a valid privacy stance; the marketing scorecard will simply mark
  site traffic NO DATA rather than inventing numbers (ADR-131 rule 6).
- Server-side conversion feeds for ad platforms (Enhanced Conversions / CAPI) are P3 scope and
  out of this ADR; nothing here precludes them.
