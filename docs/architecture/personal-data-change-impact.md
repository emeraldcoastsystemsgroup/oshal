# Change impact — personal data schema + ticketed broker (ADR-056/057)

**Question this answers:** does the personal-data architecture force new developer guidelines, or does
it get baked into the framework so developers don't have to think about it?

**Decision: bake it in.** Developers get sovereignty, audit, and the self-building schema *for free*.
Their entire surface area shrinks to **two rules**, and the framework does the rest.

---

## The two rules a developer now lives by

1. **A bot never touches a data store.** No graph driver, no Chroma client, no SQL, no vault creds in
   bot code. To read, a bot emits a **data-access intent** (ADR-056); the broker returns scoped data.
   To write, it returns a **SchemaContribution** (ADR-057); the framework persists it. *That's it.*
2. **Everything a bot learns about the user comes back as a contribution, not a side-write.** As a
   side-effect of its work the bot reverberates over what it touched — *"what can I tell about my user
   from this?"* — and returns `SchemaContribution { entities, edges, facts }` with provenance +
   confidence. It does not decide what's true or where it lands.

Everything else — resolution, dedup, "sorting the junk," scoping, gating, writing — is the framework's
job, not the developer's.

## What gets baked into the framework (so devs get it free)

| Capability | Where it lives | Dev sees |
|---|---|---|
| **Data access** | the broker (ADR-056) — sole credential holder, deterministic, tenancy-scoped | "I send an intent, I get scoped data + provenance" |
| **Self-building schema** | a contribution-ingest pipeline: **resolve → dedup → confidence-gate → write** | "I return contributions; survivors appear in the vault" |
| **Sort the junk** | entity resolution + `DEFAULT_CONTRIBUTION_FLOOR` + confidence gate | nothing — it's automatic |
| **Sovereignty / scope** | `userScopePrefix` + the vault resolver (ADR-057) | nothing — IDs are namespaced for them |
| **Audit / approval** | the `data-access` ticket gate (reused approve/close + backlog dial) | "sensitive reads + all writes/acts are gated" |
| **Provenance** | required field on every contribution + access | "I stamp source/confidence; citation is free" |

The "reverberation" can even be **framework-driven**: a core post-execution hook can auto-mine a bot's
output + the data it accessed into a draft `SchemaContribution`, so a bot that does *nothing special*
still enriches the user's schema. Opt-in deeper by returning a richer contribution.

## What this changes for EXISTING code (the migration)

Today some bots/routes touch data directly (e.g. career-hunter opens the user SQLite; the graph bot
would query the graph). Those become **broker clients**:

- **Before:** `openUserDb(sub)` → run SQL.
- **After:** emit a data-access intent → broker scopes + runs a template → returns the rows.

New bots are born compliant (they have no store access to begin with). So the migration is bounded to
the handful of existing direct-data touchpoints, not a rewrite. Track them as a checklist; until a
touchpoint is migrated it's an exception, not the pattern.

## Guideline edits (the actual doc changes)

Add to the developer guidelines / CLAUDE.md bot-authoring section:

- **"Bots are stateless over data. Read via the broker (data-access intent); write via
  SchemaContribution. Never import a DB/vector/graph client into a bot."**
- **"Anything you learn about the user is a contribution with provenance + confidence — propose, don't
  persist. The framework resolves, dedups, gates, and writes."**
- **"Cross-domain or sensitive reads, and all writes/acts, are gated tickets. Don't design a flow that
  assumes silent access."**

## Risks / sharp edges

1. **The broker becomes a hot path** — every read funnels through it. Needs the fast-path tier
   (ADR-056 §4) + per-session caching, or it's a latency choke. Bake the cache in too.
2. **Contribution spam / drift** — every bot proposing entities can flood the resolver with junk. The
   confidence floor + resolver dedup is load-bearing; tune per entity type, and log what's dropped
   (no silent truncation).
3. **Migration debt** — direct-data touchpoints that linger are tenancy/audit holes. Keep the
   checklist visible; a half-migrated system is *less* safe than the old one (mixed assumptions).
4. **Entity resolution quality** gates the whole value — bad resolution = duplicate nodes = broken
   joins = junk schema. This is the make-or-break investment (already flagged in ADR-057).

## Net

Baked in, the developer story is **smaller**, not bigger: "ask the broker, return contributions,
never touch storage." Sovereignty, audit, citation, and a self-building user model fall out of the
framework — they're not extra work the developer has to remember to do.

*(Parked, related: Jarvis must become a continuous conversation session that spawns tickets rather
than a one-shot dispatcher — its session is the natural place the per-user reasoning context lives.
See the `jarvis-continuous-conversation` note.)*
