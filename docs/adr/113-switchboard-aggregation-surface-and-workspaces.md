# ADR-113 — Switchboard: an aggregation surface, and the workspace model

- Status: Accepted
- Date: 2026-07-23
- Related: [ADR-036](036-bot-owned-application-architecture.md) (bot owns its domain), [ADR-037](037-communications-swarm.md) (comms swarm reference impl), [ADR-038](038-swarms-bundled-by-type.md) (apps bundled by type), [ADR-042](042-iot-connector-tenancy.md) / [ADR-085](085-remote-app-packages-and-registries.md) (per-user connector isolation + packaged apps), [ADR-100](100-ambient-person-model.md) (person model)

## Context

OSHAL already ships the pieces of a communications product — a `communications-bot`
node, per-user connectors (Gmail, Outlook, Twilio, LinkedIn, X, Meta, Slack…), the
inbox-ingest **Signals engine**, the LinkedIn `draft→judge→refine→approve` publish
loop, and image generation. They are spread across three store apps (Social,
Intelligent Communication, Feeds) with three ribbons and three visual dialects.

The operator's ask reframed the target: not "here's an article → make a post," but a
**portal for someone who does communications for a living** — a social-media manager,
comms lead, or agency operator who runs **several identities at once** (their own
brand, a client's, a personal presence, more than one Gmail) across **every channel**,
all day, from one desk.

Two questions fall out of that:

1. **What kind of thing is Switchboard?** A new orchestration engine, or a surface?
2. **Where does "group my accounts into brands" live** — the connector framework, or
   somewhere app-owned? It has to be user-configurable and it needs DB support.

## Decision

### 1. Switchboard is an aggregation surface that BINDS existing services

Switchboard adds **no new bot and no new LLM path**. It is a surface (ADR-036 "the bot
owns the domain, the surface is a view") that binds what already exists:

- reads ride the **per-user connector tokens** + the **inbox-ingest Signals store**;
- reasoning (ranking, reply drafting, per-platform rewrites) runs on the existing
  **communications-bot**, cost captured per user (ADR-036) — never in the controller;
- publishing reuses the existing social publish + `draft→judge→refine→approve` loop;
- visuals reuse the existing image generation.

The controller/route layer does only cheap data-access (fetch, normalize, rank). This
keeps the two-runtime split (ADR: controller orchestrates, bot executes) intact and
means Switchboard's value is **coherence**, not new capability.

### 2. Workspaces are APP-OWNED state, not a connector-framework concept

A "workspace" (a named brand/identity desk grouping a set of connected accounts) is a
**Switchboard product concept**, so it is app-owned domain state — NOT a field on the
connector framework. Rationale:

- Connectors are generic infrastructure (auth + tokens) reused by every app. Bolting a
  Switchboard-specific grouping onto `oshal_connections` would leak one app's product
  model into shared infra that other apps must not inherit.
- One connected account can belong to **more than one** workspace (a shared Slack, a
  personal Gmail used for a side brand). A single column on the connection can't express
  that; a membership mapping can.

Concretely, two Switchboard-owned tables, created at the package's lazy-DDL chokepoint
with **owner-RLS** (`buildOwnerRlsPolicyStatements`, keyed on the `oshal.current_sub`
GUC — same discipline as `oshal_email_digests`):

```
oshal_switchboard_workspaces         (workspace_id, user_sub, name, color, sort_order, …)
oshal_switchboard_workspace_accounts (workspace_id, user_sub, connection_id)   -- membership
```

Membership is keyed on `oshal_connections.connection_id`. The user organizes their
workspaces in a **Switchboard settings surface** (create/rename/recolor/delete a
workspace; assign connected accounts to it). No connector-framework change.

### 3. Workspace is a scope threaded through every read/publish

Every Switchboard read and publish takes an optional `?workspace=<id>` filter that
resolves to "the accounts in this workspace." Absent → **All workspaces** (the whole
desk). The scope lives in the URL/state, never cached, mirroring the cockpit's
`?app=` contract.

### 4. Multi-account-per-provider is a separate, deferred connector change

`oshal_connections` currently has `UNIQUE (user_sub, provider)` — one account per
provider per user. True "two Gmails" needs that constraint relaxed (a connector-
framework change), which is **out of scope here and deferred**. The workspace model is
already forward-compatible: it keys on `connection_id`, so when a second Gmail becomes
a distinct connection row, it simply becomes assignable to a workspace — no model change.

## Consequences

- **Good.** The connector framework stays generic; the professional multi-brand model
  is expressible today over the existing single-account connections; the surface inherits
  workspace scope everywhere for free; nothing new to bill or run (binds existing rails).
- **Cost.** Switchboard owns a small schema + a settings surface; workspace scope must be
  threaded through each read/publish path as sections land.
- **Deferred.** Multi-account-per-provider (relax the connections UNIQUE) and promoting
  "workspace/identity grouping" to a core concept if another app ever needs it (YAGNI —
  start app-owned, promote on the second consumer).
- **Non-goal.** Switchboard does not become a second orchestration engine; the
  queue-manager + registry stay authoritative, and the communications-bot stays the
  single accountable executor.
