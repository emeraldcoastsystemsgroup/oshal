# ADR 038 — Swarms bundled by type (the swarm catalog)

Status: **Accepted — implemented** (2026-06-15; reconciled 2026-07-31). The bundled-by-type model is the shipped app shape: comms (ADR-037) is the reference implementation and the social / storage / presentations / operations bundles are built; packaging moved to the ADR-085 store, with ADR-097 suites as shelf metadata.
Builds on: [ADR 036 bot-owned apps](036-bot-owned-application-architecture.md), [ADR 037 comms swarm](037-communications-swarm.md) (the **reference implementation**), [connectors-tenant-isolation](../architecture/connectors-tenant-isolation.md), [ADR 035 multi-tenant](035-multi-tenant-saas-foundation.md)

## Context

The Intelligent Communication (email) build proved a repeatable, harness-agnostic
pattern — see ADR-037:

> **connector (per-user OAuth) → bot (codex runs the provider CLI / claude-code
> reasons) → cockpit surface.** The bot owns its data; the surface is a view.

The product insight (owner, 2026-06-15): **bundle swarms by domain type** so a user
loads one coherent, recognizable app — *"the email swarm," "the social swarm," "the
smart-home swarm," "the devops swarm."* Each bundle ships **every provider in that
category**, so once the user connects their accounts it "just works." The Apps page
becomes a clear catalog of what each bundle loads.

## Decision

A **swarm-app** (`swarm-apps/*.yaml`) is a **category bundle** of four reused pieces:

1. **Connectors** — one per provider in the category (per-user OAuth, `user_sub`-keyed,
   AES-256-GCM, isolated — the connectors hub at `/utilities`).
2. **Provider tools** — the CLI/script a bot runs per provider. `scripts/oshal-gmail.js`
   is the template; siblings follow (`oshal-yahoo.js`, `oshal-outlook.js`,
   `oshal-linkedin.js`, …). The bot **owns the pull/push** by running these.
3. **Bot(s)** — **codex** (sandbox → can run CLIs) for fetch/act, **claude-code** for
   pure reasoning. Split into ingest / reason / act bots as a category grows (ADR-037).
4. **A cockpit surface** — the ribbon app (`ui.static`), a view over the bots' data.

Adding a provider = **a connector + a CLI tool**, never a new app. Adding a category =
a new bundle following the same four-piece shape.

### The catalog (initial)

| Swarm | Providers | Tools (CLIs the bot runs) | Surface | Status |
|---|---|---|---|---|
| **Email** | Gmail, Yahoo, Outlook/M365, IMAP | `oshal-gmail.js` ✓, `oshal-yahoo.js`, `oshal-outlook.js` | Intelligent Communication | **Gmail BUILT** (ADR-037) |
| **Social** | Facebook, LinkedIn, X/Twitter, Instagram/Threads, Mastodon | `oshal-linkedin.js` (post), `oshal-facebook.js`, … | Social composer / feed | Facebook read-only ✓; LinkedIn ready |
| **Smart home** | Home Assistant, SmartThings, Hubitat, Google Home, Alexa | per-hub CLIs | Home dashboard | planned |
| **DevOps** | Proxmox, vSphere/ESXi, Hyper-V; Terraform; health checks | hypervisor CLIs, `terraform`, healthcheck scripts | Ops console | planned — **privileged, see below** |

### Security model — privileged swarms

Consumer OAuth (email/social) = per-user bearer tokens in `oshal_connections`
(encrypted, isolated). **Privileged swarms** (hypervisor CLIs, infra) need more,
exactly as the owner called out:

- **Strong auth, not a stored bearer**: client cert, SSH private key, or interactive
  login with **2FA**.
- **"Log in now" (ephemeral)**: the user authenticates at the start of a cycle; the
  credential is **never persisted** beyond that session.
- **Single-user isolation OR ephemeral containers**: a privileged bot serves **one user
  at a time**; after each cycle it **kills the session, wipes the credentials, and logs
  out** — no cross-user, no lingering creds. Per ADR-035 this can become a per-tenant
  dedicated/ephemeral runtime.
- **No shared-workspace secrets**: privileged creds live in a per-session tmpfs scrubbed
  at cycle end (like codex's writable-home, but ephemeral and wiped).

This is the one place the standard connector model is insufficient and must be built
**before** a privileged swarm goes multi-user.

## Consequences

**Positive** — users get recognizable, one-click bundles; the connector hub + codex
CLI-runner + cockpit surface are reused per category; the platform stays harness-agnostic.

**Negative / risks** — each provider needs its own connector + CLI (real per-provider
work + each vendor's OAuth/app-review quirks, e.g. LinkedIn inbox is not available).
Privileged swarms need an ephemeral/isolated runtime + credential lifecycle that doesn't
exist yet — gated before devops goes multi-user.

## Phased rollout
1. **Email swarm** — Gmail done; add Yahoo + Outlook connectors + CLIs.
2. **Social swarm** — **LinkedIn first** (sign-in + Share, ready), then X, Instagram;
   Facebook posting after Meta review. Build the social composer surface.
3. **Smart-home swarm** — start with Home Assistant (local API) + SmartThings.
4. **DevOps swarm** — **build the ephemeral/isolated privileged runtime FIRST**, then
   hypervisor CLIs + the Terraform-writer bot + health checks.
5. **Apps page as a catalog** — each bundle, its providers, and per-provider connect-state,
   so "what am I loading" is obvious.

See [BACKLOG.md](../BACKLOG.md) for the concrete done-when items per swarm.
