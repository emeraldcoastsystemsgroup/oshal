# ADR-058 — Personal-Intelligence Service + ingestion: private, a swarm service, not a registered bot

- **Status:** Accepted — service + ingest pipeline BUILT + verified 2026-06-19 (`PersonalIntelligence
  Service.ingest`: resolve → confidence-gate → dual-write, deterministic, start-param-gated, default-
  owner footgun guarded). Live composition wiring + connector normalizers + world layer deferred.
- **Date:** 2026-06-19
- **Related:** [ADR-057 (personal data schema)](057-personal-data-schema.md),
  [ADR-056 (ticketed data-access broker)](056-ticketed-data-access-broker.md),
  [ADR-045 (two-tier graph + connector)](045-two-tier-graph-database-and-connector.md),
  [ADR (swarm application manifests)](033b-swarm-application-manifests.md)

## Context

ADR-057 defines the *shape* of the user's vault. This defines (a) how data **gets in** and (b) the
thing that owns the vault keys. The operator's constraint:

> "Private intelligence, not a public accessible registered bot. It's a swarm **service**, and that's
> a **start parameter** — it's just getting the default parameters, which are mine right now."

So the key-holder is **not a bot**. Registered bots are discoverable, selectable by the agent router,
promptable, and therefore prompt-injectable. The component that reads and writes a person's whole
life **cannot be any of those.** It is a privileged **service**, enabled by a start flag, deterministic,
with zero free-form prompt surface — exactly ADR-056's "powerful reach, zero discretion," now made
concrete as a *service*, not an agent.

## Decision

Split the world cleanly, and realize ADR-056's broker **as a service**:

### 1. The rule: bots propose, the service disposes

| | **Registered bots** (public) | **Personal-Intelligence Service (PIS)** (private) |
|---|---|---|
| In the agent/bot registry? | yes — selectable, routable, promptable | **no** — invisible to the router, never prompted |
| Vault credentials? | **none** | the **only** holder |
| What it does | work + reverberate → `SchemaContribution`; request reads → data-access intent | resolve, dedup, gate, write (ingest) + scope/run/return (broker reads, ADR-056) |
| Driven by | the LLM | **deterministic** code + policy |
| Enabled by | a manifest (`swarm-apps/`) | a **start parameter** (like `ENABLE_QUEUE_MANAGER`) |

The PIS is the **only** thing that touches a vault. Because it is not a registered bot, the agent
router cannot select it, the chat cannot reach it, and a prompt-injected bot cannot become it. It only
ever processes **contributions** and **intents** handed to it through typed interfaces — never prose.

### 2. Start parameter + defaults (single-tenant now, multi-tenant-ready)

The PIS boots from config, not a manifest — mirrors `ENABLE_QUEUE_MANAGER` / `ENABLE_AGENT_SCHEDULER`:

```
ENABLE_PERSONAL_INTELLIGENCE=true
PI_STORE_ROOT=<vault store root>          # default: platform per-tenant partition
PI_DEFAULT_OWNER_SUB=<the operator's sub>        # default params are HIS right now
PI_CONTRIBUTION_FLOOR=0.4
```

It is **multi-tenant by construction** (everything scopes to an `ownerSub`), but the **default
parameters are single-tenant — the operator's** — until other tenants exist. No redesign to go multi-tenant;
just stop defaulting the owner.

### 3. The ingestion pipeline (one path for every source)

Whether the source is a connector pull or a bot reverberation, it lands as a `SchemaContribution` and
runs the **same** pipeline:

```
normalize   raw connector data | bot reverberation → SchemaContribution (entities/edges/facts + provenance)
   ↓
resolve     entity resolution (match keys: symbol/domain/email/...) → existing node OR mint.  ← make-or-break
   ↓
sort junk   confidence-gate (< PI_CONTRIBUTION_FLOOR dropped, logged), dedup, NON-DESTRUCTIVE merge
            (newer/higher-confidence wins; never delete a prior fact, supersede it)
   ↓
dual-write  structured → graph + metric store ; unstructured → vector + graph-link ;
            scoped to ownerSub, under the PIS's vault creds only
   ↓
world-link  resolve worldRefs (security → world:company:*) — referenced, never copied
   ↓
audit       every write logged with provenance (ties into the ADR-056 access ledger)
```

### 4. Triggers (all converge on the one pipeline)

- **Backfill** — on connector link, initial ingest of history.
- **Incremental** — new email / transaction / device state, streamed in.
- **Reverberation** — a bot, post-task, emits a contribution ("what can I tell about my user from
  this?"). This is the **self-building** schema — emergent, not a separate ETL.

A core post-execution hook can auto-mine any bot's output into a draft contribution, so even a bot
that does nothing special still feeds the schema.

## Consequences

- **Smallest possible attack surface for the crown jewels.** The vault key-holder is unreachable by
  the router, un-promptable, and deterministic. You cannot social-engineer a service that only accepts
  typed contributions and scoped intents.
- **One ingest path** → resolution/gating/audit are enforced in exactly one place, for connectors and
  reverberation alike.
- **Sovereignty holds** — the PIS scopes every write to one `ownerSub`'s vault; the export bundle
  (ADR-057 §6) is just a PIS dump.

**Risks / sharp edges:**
1. **Entity resolution is the whole ballgame** (third time flagged — it's that important). Bad
   resolution = duplicate nodes = broken joins. The resolver gets real investment + a confidence model.
2. **The PIS is a single privileged component** — it must be the most-audited, least-discretionary code
   in the system. No LLM inside it. If it ever needs judgment, that judgment is a *gated ticket*, not a
   model call within the service.
3. **Default-owner footgun** — while `PI_DEFAULT_OWNER_SUB` defaults to the operator, any unscoped write lands
   in his vault. Before a second tenant, make unscoped writes an **error**, not a default-to-the operator.
4. **Non-destructive merge** — never overwrite a fact; supersede with provenance, so history (and audit)
   survives.

## Reuses (no new runtime)

- Start-flag pattern → `ENABLE_QUEUE_MANAGER` / `ENABLE_AGENT_SCHEDULER`.
- Tri-store → ADR-045 graph + Chroma + Postgres (vault layout, ADR-057).
- Contribution + scope types → `src/features/personal-data/*` (ADR-057 scaffold).
- Access ledger + gates → ADR-056.

## Deferred

- Entity-resolution model (match strategies, confidence) — its own spec; the hinge of everything.
- Per-connector normalizers (email → messages, brokerage → holdings/transactions, etc.).
- The shared **world graph** ingestion (Layer B) — now its own ADR, BUILT:
  [ADR-061 (World-Intelligence layer)](061-world-intelligence-layer.md).
