# Business-domain email DNS (DMARC + DKIM)

State and upkeep of email authentication for `emeraldcoastsystemsgroup.com` — the business
domain that owns every partner-app registration and app-review mail thread
(see [../partner-app-registration.md](../partner-app-registration.md)).

## As-built (2026-07-08)

Mail is Google Workspace (`aspmx.l.google.com` MX). All three sender-auth records are live
in the Cloudflare zone (account `owner@example.com's Account`, free plan):

| Record | Name | Value |
|---|---|---|
| SPF | `@` TXT | `v=spf1 include:_spf.google.com ~all` (pre-existing) |
| DKIM | `google._domainkey` TXT | `v=DKIM1; k=rsa; p=MIIB…` — 2048-bit, selector `google`, generated in Google Admin 2026-07-08 |
| DMARC | `_dmarc` TXT | `v=DMARC1; p=none; rua=mailto:maintainer@emeraldcoastsystemsgroup.com; fo=1` |

Google Admin (Apps → Google Workspace → Gmail → Authenticate email) shows
**"Authenticating email with DKIM"** — outgoing mail is signed. This closed the Cloudflare
Security Insights "DMARC Record Error" findings (the zone's Recommendations banner reads
"All set").

## Access notes

- The Workspace admin is **`maintainer@emeraldcoastsystemsgroup.com`** — the personal
  gmail account has **no** admin.google.com access.
- The wrangler OAuth token on the dev box is `zone:read` only; DNS edits go through the
  Cloudflare dashboard (or a purpose-made API token).
- **Never click "Generate new record"** on the Google Admin DKIM page casually — it rotates
  the key and breaks signing until the new TXT value is republished in Cloudflare.

## Verify

```powershell
Resolve-DnsName _dmarc.emeraldcoastsystemsgroup.com -Type TXT -Server 1.1.1.1
Resolve-DnsName google._domainkey.emeraldcoastsystemsgroup.com -Type TXT -Server 1.1.1.1
```

Both must return the values above. If a name looks missing right after an edit, query the
zone's authoritative nameserver (`ainsley.ns.cloudflare.com`) — public resolvers negative-cache
NXDOMAIN for up to 30 minutes.

## Follow-up: tighten the DMARC policy

`p=none` is monitoring-only. Aggregate (rua) reports arrive at
`maintainer@emeraldcoastsystemsgroup.com`. After ~2 weeks of reports showing only Google
as a passing source, edit the `_dmarc` record in Cloudflare:

1. `p=none` → `p=quarantine`
2. after another clean stretch, `p=quarantine` → `p=reject`

## security.txt (also from the same Cloudflare Insights report)

Enabled 2026-07-08 via zone → Security → Settings → Security.txt. Served by Cloudflare at
`https://emeraldcoastsystemsgroup.com/.well-known/security.txt`:
`Contact: mailto:maintainer@emeraldcoastsystemsgroup.com`, `Expires: 2027-07-08` —
**renew the Expires date before July 2027** (same edit drawer).

## Deliberately not enabled (2026-07-08 decisions)

- **Block AI bots / AI Labyrinth**: left OFF — the goal for the public sites is visibility
  and portfolio reach; AI crawler readability works in our favor.
- **Bot Fight Mode**: left OFF — this zone carries tunnel-backed API hostnames
  (`agent.emeraldcoastsystemsgroup.com` → `ecsg-agent`), and the free-plan BFM has no
  allowlist, so it would challenge legitimate automated calls.
