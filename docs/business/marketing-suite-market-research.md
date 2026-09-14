# marketing suite — market scan: comparable products, pricing, self-hostable stack, compliance

> **Status: RESEARCH, read 2026-09-13.** Every price and limit below was read on that date from the
> cited page. Figures are external planning bands (±30%), not commitments — re-check a vendor's
> pricing page the week it is actually adopted. **UNVERIFIED** marks a figure the primary page did not
> render or did not state; it comes from a dated third-party source or search-index text. This file
> feeds the [marketing suite application spec](../apps/marketing-suite-spec.md); it makes no claim
> about how oshal compares beyond what the spec can show in its own code.

## Why this scan exists

The [marketing engine](./marketing-engine-spec.md) ships campaigns, consent gates, a scorecard and
budget proposals, but email lists, sequences, SMS, contacts, ads and a finance-tied budget are not
built. Before specifying them, this scan records what comparable products do at each price point,
which self-hostable projects cover the same ground, and which legal and mailbox-provider rules any
email/SMS feature has to meet.

## A. All-in-one marketing platforms

| Product | Covers | Free tier | Entry paid | Source |
|---|---|---|---|---|
| HubSpot Marketing Hub | CRM, email, forms, landing pages, automation, ads, social, campaigns | 2 users; 2,000 email sends/mo; HubSpot branding | Starter $20/seat/mo regular (a limited-time $7/seat annual offer was shown): 1,000 contacts, sends = 5× contacts, ≤10 automated actions. Pro $800/mo (3 seats, 2,000 contacts, A/B, unlimited automation, campaign budgets) + $3,000 onboarding | hubspot.com/pricing/marketing; legal.hubspot.com product catalog |
| Zoho Marketing Plus | Email, social, automation, surveys, webinars, events, landing pages, unified analytics | none (15-day trial) | $25/mo annual, $30 monthly: 1 user, 1,000 contacts | zoho.com/marketingplus/pricing.html |
| Zoho Campaigns | Email, segmentation, workflows, A/B, pop-up forms | 2,000 contacts; 6,000 emails/mo | Standard ≈ $3–4/mo for 500 contacts — **UNVERIFIED** | zoho.com/campaigns/pricing.html |
| ActiveCampaign | Automation, email, landing pages, forms, CRM; SMS add-on | none (14-day trial) | Starter ≈ $13–19/mo for 1k contacts — **UNVERIFIED** (page renders no figure; sources disagree) | activecampaign.com/pricing |
| Brevo | Email, SMS, WhatsApp, automation, CRM | 300 emails/day — **UNVERIFIED** | Starter $9/mo (5k emails, no automation); Standard $18/mo adds automation + A/B — **UNVERIFIED** | brevo.com/pricing |
| Mailchimp | Email, automation, segmentation, SMS, landing pages | 250 contacts; 500 sends/mo | Essentials from $13/mo (sends 10× contacts); Standard $20/mo (automation flows, AI) | mailchimp.com/pricing/marketing |

## B. Email marketing / newsletters

| Product | Covers | Free tier | Entry paid | Source |
|---|---|---|---|---|
| Kit | Newsletters, landing pages/forms, sequences, automations, paid subscriptions | up to 10,000 subscribers; unlimited broadcasts and forms | Creator $39/mo for 1k subscribers: sequences, visual automations, A/B subject lines, SMS | kit.com/pricing |
| Loops | SaaS marketing + transactional email, automations | 1,000 contacts; 4,000 sends / 30 days; branding | ≈ $49/mo for ≤5k contacts — **UNVERIFIED** | loops.so/pricing |
| beehiiv | Newsletter, website, ad network, referrals | ≤2,500 subscribers; no automations or A/B | Scale $43/mo annual: automations, A/B, referrals | beehiiv.com/pricing |
| MailerLite | Email, automation, landing pages, forms | 250 subscribers; 2,500 emails/mo; 3 automations | Comfort from $12/mo: 50 automations, A/B, AI writer | mailerlite.com/pricing |

## C. Email sending APIs (the rail oshal would send through)

| Product | Free allowance | Entry paid / overage | Source |
|---|---|---|---|
| Resend | 3,000/mo (100/day), 3 domains; marketing 1,000 contacts | Pro $20/mo for 50k, $0.90/1k over; Marketing $40/mo for 5k contacts | resend.com/pricing |
| Postmark | 100/mo developer tier | Basic $15/mo for 10k, $1.80/1k over; broadcast streams included | postmarkapp.com/pricing |
| Amazon SES | new-account AWS free-tier credits (up to $200, 6 months) | $0.10/1k à la carte; dedicated IP $15/mo + per-email fee | aws.amazon.com/ses/pricing |
| SendGrid | 60-day trial, 100/day (no permanent free plan) | Essentials $19.95/mo for 50k; Pro $89.95/mo (dedicated IPs) | twilio.com/en-us/products/email-api/pricing |
| Mailgun | 100/day, 1 domain | Basic $15/mo for 10k, $1.80/1k over | mailgun.com/pricing |

## D. SMS

- **Twilio US** (twilio.com/en-us/sms/pricing/us): $0.0083 per SMS segment in or out on 10DLC,
  toll-free and short code; MMS $0.022 out; carrier pass-through fees $0.0025–$0.0135 per message;
  failed message $0.001; local number $1.15/mo, toll-free $2.15/mo, short code $1,000/quarter.
- **A2P 10DLC registration** (twilio.com/en-us/phone-numbers/a2p-10dlc): brand one-time $44 Standard,
  $4 Low-Volume Standard or Sole Proprietor; campaign vetting $15 one-time; campaign fee $1.50–$10/mo
  by use case ($2 Sole Proprietor). Low-Volume < 6,000 msgs/day; Sole Proprietor < 1,000/day on one
  number. Twilio's help article lists $4.50 / $46 brand fees — **UNVERIFIED** (read via search index).
- **Toll-free:** verification is required before any US/Canada SMS; the page states no fee.
- **Telnyx** (telnyx.com/pricing/messaging): 10DLC $0.004/part, toll-free $0.0055, number $1/mo, plus
  carrier fees. **Plivo** (plivo.com/sms/pricing/us): long code $0.0077/SMS, number $0.50/mo, plus
  carrier surcharge. Neither page lists 10DLC registration fees.
- **SMS marketing apps:** SimpleTexting from $39/mo for 500 credits (simpletexting.com/pricing);
  Postscript $49 monthly minimum + $0.009/SMS (postscript.io/pricing); Attentive unpublished.

## E. Social scheduling

| Product | Free tier | Entry paid | Source |
|---|---|---|---|
| Buffer | 3 channels, 10 queued posts each, 1 user | Essentials $5/channel/mo annual; Team $10 (approvals) | buffer.com/pricing |
| Hootsuite | none (14-day trial) | Standard $99/mo annual, 10 accounts | hootsuite.com/plans |
| Later | none (14-day trial) | Starter $18.75/mo annual | later.com/pricing |
| Sprout Social | none (30-day trial) | Essentials $79/seat/mo annual | sproutsocial.com/pricing |
| Typefully | 15 posts/mo — **UNVERIFIED** | ≈ $12.50–19/mo — **UNVERIFIED** | typefully.com/pricing |
| Postiz (AGPL, self-host free) | self-host | hosted $29/mo, 5 channels | postiz.com/pricing |
| Mixpost (MIT Lite) | Lite: Facebook Pages, Mastodon, X only | Pro $299 one-time | mixpost.app/pricing |

## F. Web and product analytics

| Product | Free tier | Entry paid | Source |
|---|---|---|---|
| PostHog | 1M events, 5k replays, 1M flag requests / month | $0.00005/event after 1M | posthog.com/pricing |
| Plausible | none (30-day trial) | $9/mo for 10k pageviews | plausible.io |
| Umami | self-host free; cloud 100k events — **UNVERIFIED** | cloud Pro $20/mo — **UNVERIFIED** | umami.is/pricing |
| Fathom | none (7-day trial) | $15/mo for 100k pageviews | usefathom.com/pricing |
| GA4 | standard free (14-month retention) | 360 unpublished | support.google.com/analytics/answer/11202874 |

## G. Campaign budget and spend planning

- **HubSpot campaign budget** (Pro/Enterprise only; knowledge.hubspot.com/campaigns/manage-your-campaign-budget):
  budget items and spend items per campaign, remaining budget, ad spend synced in as rows.
- **Planful for Marketing** (planful.com/solution-hub/marketing-budget-management): budget vs actual
  by campaign/channel/period, expenses carrying GL codes and PO numbers, ad-platform and ERP actuals,
  reallocation with approvals. No published pricing.
- **Uptempo (formerly Allocadia)** (support.allocadia.com "Budgeting and Planning Overview"): plan and
  budget hierarchy tied to objectives, actual vs forecast vs committed, actuals from the ERP. No
  published pricing.
- **Shared shape:** plan → allocate → commit → pull actuals (ledger, ad platforms) → variance and
  return per campaign. In the products scanned this appears at the $800+/mo tier or in a separate
  planning tool; it is the part of the suite that attaches to a finance project.

## H. Self-hostable open-source stack

| Project | License | Covers | Hosting needs | Source |
|---|---|---|---|---|
| listmonk | AGPL-3.0 | Newsletters, lists, campaigns, transactional, SMS gateway | Go binary + PostgreSQL | github.com/knadh/listmonk |
| Mautic | GPL-3.0 | Automation, email, landing pages, forms, lead scoring | PHP 8.2+, MySQL/MariaDB | mautic.org |
| Keila | AGPL-3.0 | Newsletters, sign-up forms, sends via SES/Postmark/SMTP | Elixir + PostgreSQL | github.com/pentacent/keila |
| Dittofeed | MIT | Journeys/broadcasts over email, SMS, push; segments | PostgreSQL + ClickHouse (+ Temporal) | github.com/dittofeed/dittofeed |
| Postal | MIT | Self-hosted mail server | 4 GB RAM, MariaDB, outbound port 25 | docs.postalserver.io |
| Plausible CE | AGPL-3.0 | Web analytics (cloud-only funnels/revenue) | PostgreSQL + ClickHouse | github.com/plausible/analytics |
| Umami | MIT | Web analytics | Node + PostgreSQL | github.com/umami-software/umami |
| PostHog | MIT (except `ee/`) | Product analytics, replay, flags | 4 GB RAM hobby deploy | github.com/PostHog/posthog |
| Chatwoot | MIT (+ enterprise folder) | Shared inbox across chat, email, SMS, social | Rails, PostgreSQL, Redis | github.com/chatwoot/chatwoot |
| Postiz | AGPL-3.0 | Scheduling across ~14 networks | Docker, PostgreSQL, Redis | github.com/gitroomhq/postiz-app |

AGPL and MIT code can be *called* over HTTP from oshal without a licensing question; vendoring any of
it into the tree must stay AGPL-compatible (the core is AGPL-3.0-or-later).

## I. Compliance any email or SMS feature must meet

**Email**
- **CAN-SPAM** (ftc.gov CAN-SPAM compliance guide): truthful headers and subject; identify the
  message as an ad; a valid physical postal address; a working opt-out honored within 10 business
  days and kept working 30 days after the send; opt-out may cost nothing and ask for nothing beyond an
  email address; liability stays with the sender when a vendor sends. Transactional mail is largely
  exempt.
- **GDPR** Art. 7 (demonstrable consent; withdrawing as easy as giving) and Art. 21 (objection to
  direct marketing stops processing). **ePrivacy 2002/58/EC Art. 13(2):** "soft opt-in" for existing
  customers about similar products, with an objection option at collection and in every message.
- **CASL** (S.C. 2010 c.23 ss. 6, 10, 11): consent, sender identification, unsubscribe honored in 10
  business days and working 60 days; implied consent lasts 2 years after purchase, 6 months after an
  inquiry.
- **Gmail** (support.google.com/a/answer/81126, /14229414): all senders need SPF or DKIM, PTR, TLS,
  spam rate < 0.3%. Senders of >5,000/day to Gmail also need DMARC (p=none is enough), From-domain
  alignment, and RFC 8058 one-click unsubscribe plus a visible link on marketing mail; honor
  unsubscribes within 48 hours. Enforcement ramped from November 2025.
- **Yahoo** (senders.yahooinc.com/best-practices): SPF + DKIM + passing DMARC, one-click
  List-Unsubscribe, honored within 2 days, spam rate < 0.3%.
- **RFC 8058:** `List-Unsubscribe` with one HTTPS URI plus `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click`, both DKIM-signed; the POST carries no cookie or auth and the URI alone
  identifies recipient and list.

**SMS**
- **TCPA, 47 CFR 64.1200:** prior express written consent for marketing texts (signed agreement,
  consent not a condition of purchase); no solicitations before 8 a.m. or after 9 p.m. recipient-local;
  revocation by any reasonable means honored within 10 business days; Do-Not-Call applies.
- **CTIA Messaging Principles (May 2023):** record each opt-in (time, medium, call-to-action text,
  campaign, number); send an opt-in confirmation naming the program, HELP contact, frequency and fees;
  one opt-in per campaign; act on STOP, END, UNSUBSCRIBE, CANCEL, QUIT in any case; one final opt-out
  confirmation; no rented lists.
- **Carrier registration:** 10DLC brand + campaign, or toll-free verification, before sending (see D).
  Twilio's default filtering already handles STOP/UNSUBSCRIBE/END/QUIT/STOPALL/CANCEL and, since
  2025-04-29, REVOKE/OPTOUT.

## What the scanned products have in common

1. Contacts with tags, custom fields and segments; advanced segmentation is a paid upgrade.
2. Sign-up forms and landing pages, often on the free tier.
3. Automations/sequences, usually from the first paid tier.
4. A/B testing at the first or second paid tier.
5. Templates and a visual editor.
6. Branding removal as the upsell.
7. Deliverability tooling (dedicated IPs, validation) at higher tiers.
8. Transactional and marketing email on one rail (Resend, Loops, Postmark).
9. SMS as an add-on tier.
10. Social scheduling bundled only in the all-in-ones; otherwise a separate tool.
11. Analytics/attribution through campaign reports or an external analytics product.
12. AI copy assistance.
13. Per-campaign budget and spend only at the top tiers or in a dedicated planning tool.
14. Pricing by contact count with send caps as a multiple of contacts, per seat, or per channel.
