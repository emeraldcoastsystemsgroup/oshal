# ADR-090 — Skills as first-class packages: origin, and the four "who may X" axes (depend / call / set / trust)

> **Numbering note:** ADR number 090 is shared by two files — this one (“ADR-090-skills”) and [090-github-actions-to-local-ci.md](090-github-actions-to-local-ci.md) (local CI; cited elsewhere as **ADR-090-CI**). Neither is renumbered, so existing links stay valid.

- **Status:** **Accepted — all open questions O1–O8 decided by the operator 2026-07-13**
  (via the cost/benefit decision slate; every recommendation taken as proposed — see the
  resolutions inline in "Open questions" below). Written 2026-07-11 from the operator's raise while
  travelling. Nothing built yet — this ratifies the DESIGN; each build phase still lands per
  wave. Read with [ADR-085](085-remote-app-packages-and-registries.md) (app packages, dependency
  resolver, audit gate), [ADR-093](093-packaged-app-runtime-placement.md) (D1/O5 runtime
  placement) and [docs/apps/swarm-store-migration-plan.md](../apps/swarm-store-migration-plan.md)
  (§2 kernel tiers — signed off 2026-07-13).
- **The one-line shape:** every hard question in the store model turns out to be *"who may X, and
  can an admin pin it?"* — **DEPEND** (visibility) · **CALL** (authorization) · **SET**
  (configuration authority) · **TRUST** (provenance). Four axes, one mechanism. Conflating any two
  of them is what makes the design feel muddy.
- **Date:** 2026-07-11
- **Author:** maintainer@emeraldcoastsystemsgroup.com

---

## Context — the problem the operator raised

The migration plan (§2) split the world into *kernel skills* (shared: voice, RAG, storage,
notifications) and *apps*. That split is too coarse. Three cases break it:

1. **The one-off.** An Uber-Eats API integration has exactly one consumer. It is not general.
   Putting it in the kernel is wrong; it belongs to its app.
2. **The app-introduced-but-shareable.** A new analytics app needs an **enterprise database** — it
   brings a DB skill *and* the infra to run it. That skill is not in core (core never knew about
   that database). Later a *second* app declares it needs the same DB skill. Now the dependency
   **exists but isn't installed**,
   and there is nowhere for the resolver to get it from → an **unresolvable dependency tree**.
3. **The unknown general.** We can't enumerate every general skill up front. Some become general
   only *after* a second consumer appears.

And a fourth thing that must not be conflated with the above: a DBA skill can `DROP TABLE`.
**Who may depend on a skill and who may run it are different questions.**

### Terminology collision (must be settled before anything is built)

The word "skill" is already taken, twice:

| Term in use | Means | Where |
|---|---|---|
| **skill** | an *Agent-Skills* markdown bundle imported into a bot | [ADR-089](089-skill-import-adapter.md), `src/features/skill-import/` |
| **capabilities** | a bot's *routing tags* (`[audio-transcription, rag-query]`) | every manifest, the call-out router |
| **skill** *(this ADR / the operator)* | a **shared capability module** apps depend on and call (voice, DB, DBA) | proposed |

**Recommendation:** keep **"skill"** for *this* concept (it's the intuitive word and the one the
operator will keep using), and disambiguate ADR-089's as **"Agent-Skills import"** — that is
literally what it is (an adapter for an external format we don't own; the slice name
`skill-import` stays accurate). Do **not** reuse "capabilities" — it means routing tags.
*Open question O1 below.*

---

## Decision (proposed)

### 1. A skill is a first-class, publishable artifact — with three origins

| Origin | Where it lives | Example | Who may depend |
|---|---|---|---|
| **Kernel skill** | in the image, always present (Tier-0b) | voice/TTS-STT, RAG, storage, notifications, deck-gen, graph | anyone — always satisfiable |
| **Skill package** | its own entry in the store (`type: skill`), installed like an app | `acme/enterprise-db`, `dba/postgres-admin` | per its **visibility** (below) |
| **App-private skill** | bundled inside one app's package, unpublished | `uber-eats-api` | nobody — it is not resolvable |

This is what dissolves case 1 and 2: Uber-Eats is **app-private**; the enterprise-DB skill is a
**skill package** that *ships beside* the app that introduced it rather than inside it, so a second
app can legitimately require it.

### 2. TWO ORTHOGONAL AXES — this is the whole unlock

The operator's instinct reached for `public/private/protected` *and* for "role based / bot names / secure"
in the same breath. They are two different fields and must never be one:

**Axis A — VISIBILITY: who may *DEPEND ON* it.** A packaging/API concern.

| Level | Meaning |
|---|---|
| `private` | owning package only. Not published. Another app declaring it → resolver **fails closed** with an actionable error: *"skill X is private to app A — promote it to a published skill before depending on it."* |
| `internal` | resolvable only within a publisher/namespace (the `acme/*` suite's apps may use `acme/*` skills; a stranger's app may not). The operator's "protected." |
| `public` | published in the store catalog; any app may declare it. Kernel skills are implicitly public. |

**Axis B — AUTHORIZATION: who may *CALL* it at runtime.** A security concern. **Reuse what
already exists** — do not invent a parallel model:

- `callableBy: SwarmAccessRole[]` — the ADR-087 primitive (`operator` | `swarm` | `jarvis`),
  already enforced for bots. A DBA skill declares `callableBy: [operator]` → Jarvis can neither
  discover nor invoke it.
- **Capability-scoped exposure** (ADR-067): a skill's tools appear only in the prompts of bots
  whose declared `capabilities[]` match — a bot doesn't get `DROP TABLE` because it exists.
- **Action-safety + confirm gate** (ADR-065/067): mutating/destructive operations are marked and
  require explicit `confirm: true`. `DROP TABLE` is not a read.

**The two axes are independent, and that is the point.** `acme/enterprise-db` can be **`public`**
(any app may *depend* on it) *and* **`callableBy: [operator]`** (only an operator-role caller may
*run* its destructive ops). "Public" never means "safe for anyone to execute."

**Axis C — PROVENANCE (already built):** first-party vs third-party, audit gate + quarantine on
install ([ADR-085](085-remote-app-packages-and-registries.md), the ClawHub lesson). Unchanged.

**Axis D — CONFIGURATION AUTHORITY: who may *SET* it.** *(Operator raise, 2026-07-11: "are bot
settings saved to a personal profile or controlled by the admin — can a bot's settings be set at
default and overridden at the profile layer?")* A **policy** concern, and the same
"who-may-X + can-an-admin-pin-it" shape as A and B — so it reuses the same mechanism.

**Today there is no chain at all** (verified 2026-07-11): bot settings are a *single* swarm-global
row per bot in `agents` (`api_provider_id`, `model_id`, `provider_overrides`, `persona`, `tools`)
— **admin-only, no per-user layer**. Meanwhile per-user settings exist as **10 bespoke tables**
each invented by whichever app needed one (`ambient_user_settings`, `feed_settings`,
`oshal_content_settings`, `oshal_storage_prefs`, `shop_preferences`, `user_preferences`,
`user_model_*`). `byo-llm-routes.ts` is a per-user provider override bolted on outside any model.
The manifest `settings:` schema ships `type/default/label` — **no scope, no lock**.

**Proposed resolution chain — later layer wins, unless a higher layer LOCKED it:**

| # | Layer | Set by | Example |
|---|---|---|---|
| 1 | **Package default** | the manifest/persona author | `readAloudVoice: gemini-tts` |
| 2 | **Deployment policy** | swarm operator — **may LOCK**, pinning it against lower layers | `model`, `provider`, cost caps |
| 3 | **Tenant/group** | org/school admin (multi-tenant) | class-wide voice |
| 4 | **User profile** | the end user — **only** if the setting's `scope` permits it *and* no higher layer locked it | daily goal, TTS voice |

Every setting therefore declares:
- `scope: deployment | tenant | user` — the **lowest** layer permitted to set it
- `lockable` (+ an operator-set `locked`) — pin it so lower layers cannot override
- `secret: true` — **never** lands in any profile; goes to the credential broker

**The line that must not be blurred:**
- **Cost / data-egress / authority** settings (provider, model, harness, tool grants) →
  `scope: deployment`, lockable, **admin-only**. A user repointing a bot's provider spends the
  *operator's* money and moves *other people's* data.
- **Preference / experience** settings (TTS voice, verbosity, difficulty, goals) → `scope: user`.
  This is the profile-override layer.
- **BYOK is the principled exception:** a user overriding the provider *with their own key* is
  legitimate **because cost accountability follows the key**. That is why `byo-llm` feels right
  while "let users pick the model" feels wrong — the rule, not a vibe.

Little Monsters is the concrete case: the kids set their tutor's voice and daily goal (user
scope); they can never touch which LLM it runs on (deployment scope, locked) — that is the operator's
spend and the school's data. **And skills have settings too** (an `acme/enterprise-db` skill's connection
string is `scope: deployment` + `secret: true`), which is why this belongs in the same model
rather than a separate one.

**Consolidation consequence:** the 10 bespoke per-user tables should collapse into one RLS'd
per-user settings store keyed by `(user_sub, app|skill, key)`, which the manifest `settings:`
schema declares into. That is a Wave-0-sized item, not a carve-time one.

#### Axis D applied to CREDENTIALS — "the payer picks" *(operator raise, 2026-07-11)*

**Verified current state:** every bot container mounts the **same host path** for provider auth —
`x-codex-auth-volume: ${CODEX_CONFIG_HOST_PATH:-~/.codex}:/root/.codex`, same for `~/.claude` and
`~/.gemini`. **Every bot in the swarm therefore authenticates as the OPERATOR.** A per-user path
does exist (`byo-llm-routes.ts` — an `any-llm` connector where a user pastes their own
`baseUrl`/`apiKey`/`model`, held in the broker), and `chat_tasks.owner_sub` already attributes
cost per user — but the *default* for every bot is the operator's subscription.

For a store that installs **other people's apps**, that is the sharpest hole in the model: a
third-party package's bots would run on the operator's key.

**The rule that resolves it — THE PAYER PICKS.** Configuration authority over inference follows
whoever's credential is being spent:

| Config | Owner | Rationale |
|---|---|---|
| **Harness** (codex / claude / cline / gemini) | **Central (operator)** | It is what's installed in the image — infrastructure, not app choice. |
| **LLM provider + model + key** | **Central (operator)** by default; a **user's BYOK overrides it *with their own key*** | Cost + data egress + ToS. Whoever pays chooses the model and caps the spend. |
| **The app's DOMAIN APIs** (Uber-Eats, SAM.gov, Walmart) | **App declares** (`dependencies.connectors`), **the USER credentials** them via the broker | It is the *user's* Uber/Gmail account — never the operator's. |

**An app may declare an inference HINT, never an inference BINDING.** (`preferredTier: strong`,
not `model: gpt-5`.) Two reasons, and the second is the bigger one:

1. **Security.** If a package could set its own LLM endpoint/key, it could point inference at the
   *author's* server — every prompt and completion, including other users' data, exfiltrated
   through a config field. It could also spend the operator's subscription on an expensive model.
2. **It would kill Token Chase.** The entire moat ([ADR-046](046-token-chase-checkpoint-replay-optimization.md),
   [ADR-049](049-oshal-as-aggregation-platform.md)) is that the *operator* can route any workload
   to the cheapest provider that still clears the quality bar. **That is only possible if model
   selection is centrally owned.** An app pinning its own model makes vendor-neutrality
   unenforceable — the product thesis depends on this boundary, not just the security posture.

**Open gap for the store (see O8):** the default credential is a *shared operator identity*
mounted into every bot. Before third-party packages are installed, execution must resolve the
credential from the **caller** (user BYOK → tenant key → operator pool *with a cap*), and
`chat_tasks` must record **which key paid**, not only whose task it was.

#### …"except in a public tenant, where every user wants their own everything" *(operator, same breath)*

Correct — and it **confirms** the model rather than breaking it, because **"operator" is not a
person, it is a ROLE AT A BOUNDARY, and the boundary is the TENANT.** That is precisely why layer
3 exists:

| Layer | Who | In a family swarm | In a public deployment |
|---|---|---|---|
| 2 · **Deployment policy** | the platform host | the operator | the operator (outer guardrails ONLY: what is installable at all, hard spend caps, security policy) |
| 3 · **Tenant policy** | the tenant admin | (collapses into 2) | **the user themselves** — a tenant-of-one |
| 4 · **User profile** | the end user | the kids | the same person as layer 3 |

**In a public tenant, tenant collapses to the user — so they BECOME the operator of their own
tenant:** their key, their model, their apps, their domain. **"The payer picks" still holds,**
because now they are the payer. The authority boundary simply slides down; no new mechanism.

This already matches OSHAL's multi-tenancy posture (isolation *per tenant* — own DB/namespace/
cluster, **not** shared-DB SaaS), so "their own domain" is literal, not a metaphor.

**THE SHARP CONSEQUENCE — this is the real finding:** *the shared-OAuth mount is exactly what
blocks going public.* You cannot mount the host's `~/.codex` into a stranger's tenant; it breaks
on **ToS** (a personal OAuth serving a multi-tenant service), **cost** (their inference on your
subscription) and **isolation** (one credential spanning tenants) simultaneously. Therefore:

> **In a public/multi-tenant deployment, BYOK is mandatory.** Every tenant brings its own key, or
> draws from a *metered, capped, billed* pool.

**O8 is therefore the gate to the entire public/multi-tenant future** — the public store, any SaaS
offering, federated deployments. It is not a polish item; it is a precondition.

##### …but the ADMIN-SHARED DEFAULT stays. Do not break the sandbox swarm. *(operator, explicit)*

**"BYOK mandatory" applies ONLY to the public/multi-tenant mode.** An **admin-shared default is
the correct design for a sandbox / family / single-tenant swarm** and remains a **first-class,
supported mode** — not a deprecated path, not a fallback-of-shame. It is the last link in the
chain, and a legitimate one:

```
user's own key (BYOK)  →  tenant key  →  ADMIN-SHARED DEFAULT (capped)  →  refuse
```

**Behaviour for the existing swarm must be unchanged.** Today the mount means every bot silently
uses the operator's key. After O8 a *policy* says "shared operator key → granted to first-party
apps, cap $X/day" — and every bot still uses the operator's key. **Identical behaviour.** The
three differences are purely additive:

1. **Explicit** — a declared grant, not an implicit side-effect of a volume mount.
2. **Capped + attributed** — `chat_tasks` records *which key paid*, so the spend is visible.
3. **Revocable per-app** — the only part the store actually needs.

**The one new rule: the shared default is SCOPED BY TRUST.** A newly installed **third-party**
package does **not** silently inherit the operator's key. The operator decides once, per app:

> `some-stranger/app` wants inference → **Grant shared key** (capped) · **Require BYOK** · **Deny**

In a sandbox swarm every app is first-party and operator-installed, so the deployment policy is
simply *"grant the shared key to local apps"* → **zero friction, nothing changes.** The gate only
fires when code the operator did not write wants to spend the operator's subscription — precisely
when they would want to be asked.

**Implementation note — CORRECTED after a six-reader code audit (2026-07-12).** An earlier draft
said *"route the LLM cred through the connector token broker"*. **That is the wrong transport**,
verified against the adapters. There are **two credential species** and they need different
carriers:

1. **Static API keys / OpenAI-compatible endpoints — the per-call "bullet" works, and is already
   LIVE in production.** The proven per-user LLM injection channel is **`byoLlmConnection`**: a
   typed per-request body field (controller decrypts the caller's key via
   `getUserLlmConnection` / `resolveUserLlmConnection` → `BotNodeClient.execute` →
   `POST /api/swarm-execute` → ephemeral per-request `OpenAIProvider` in `TaskController`).
   BYO-LLM, the free-tier rotation, AND the operator exemption (`OSHAL_OPERATOR_SUBS`) all ship
   on this seam today — per-user LLM branching is not hypothetical. Known limitation (BACKLOG):
   when `byoLlmConnection` is present the **agentic loop is bypassed** (reasoning-only turns);
   wiring it into a CLI harness is unbuilt.
2. **Vendor OAuth logins (ChatGPT `auth.json`, `~/.claude/.credentials.json`, `~/.gemini`) — the
   bullet CANNOT work, structurally.** These are **stateful, self-rotating files**: the CLI writes
   the rotated token back to whatever home it is given, and codex's refresh token is
   **single-use**. Three facts from the code: (a) the connector broker's `.oshal-cred-*`
   workspace files are **invisible to the CLIs' auth machinery** (they read `$HOME` paths and env,
   not cwd files); (b) the claude adapter **actively strips** an OAuth token injected as
   `ANTHROPIC_API_KEY` (`sk-ant-oat01-*` tokens expire in ~8h; the CLI would treat them as a
   permanent key); (c) per-spawn HOME redirection for claude was **tried and reverted**
   (`ClineCLIWrapper.js` PHASE_54 note: *"the claude binary uses os.homedir() internally and
   cannot authenticate when HOME is redirected"*). An OAuth credential must therefore live in a
   **canonical, writable, persistent home per identity**, refresh serialized **per home**. The
   shared mount *is* exactly one such home — the admin-shared default. Per-user OAuth = per-user
   home directories selected at dispatch (codex already has the seam — `authSourcePath` /
   `_ensureHome` rewrites `HOME`/`CODEX_HOME` per spawn; claude has **no** such seam today), each
   populated by the **vendor's own login flow** (never brokered — ToS).

So O8 in one line: **policy at the per-user resolution seam that already exists**
(`resolveUserLlmConnection`), carried by `byoLlmConnection` for keys/endpoints and by
**home-selection** for OAuth logins — not a new subsystem, and **not** the connector broker. The
refresh-race gate does *not* disappear; it becomes per-home.

**Audit fallout — a live latent bug found while verifying this (tracked in BACKLOG):** the codex
prime-gate comment claims the primer proves the token *"fresh in the shared file"*, but the
adapter copies `auth.json` into a per-task home and the CLI writes the rotated (single-use!)
refresh token **there** — **no write-back to `/root/.codex/auth.json` exists anywhere** (TS
adapter and JS wrapper both). One in-container refresh strands the only valid refresh token in a
dead task workspace; every later task re-copies the stale, already-spent one → codex auth death
until the operator re-logs in on the host. (Note: the 2026-06-12 "codex broken" episode was a
model-name mismatch, NOT this — this bug only fires when a refresh happens *inside* a task, so it
presents as intermittent auth death after long-running or idle-spanning codex work.)

### 3. Identity: namespaced + semver

`<publisher>/<name>@<semver>` — `oshal/voice`, `acme/enterprise-db@^1.2`, `little-monsters/education-tools`.
A store with many authors needs collision-proof ids, and the resolver needs ranges.

### 4. Dependency resolution — extend the machinery that already exists

The app resolver is **already built** (ADR-085 v0.4.0): forward-resolve → installed → core → store
(recursive) → **fail-closed**, cycle-guarded, provenance-stamped; plus ref-counting and the
reverse-dependency uninstall guard (v0.5.0). Extend it from `dependencies.apps` to
`dependencies.skills`:

- resolve order: **installed → kernel (always satisfied) → store (by visibility) → fail closed**
- `private` skill referenced from outside → hard error naming the promotion path (§5)
- uninstall: removing `acme/enterprise-db` while an app requires it is **blocked** with the impact list —
  exactly the `trading`→`world` guard already shipped
- the existing `provides` / `uses` fields in the SDK contract (documented in
  `BUILDING-EXTENSIONS.md`, **not yet in `types.ts`**) become the real declaration surface

### 5. The promotion path — how "general skills we don't know yet" get discovered

You do **not** need to enumerate general skills up front. A skill is born **app-private**; when a
second consumer appears, it is **promoted** to a published skill package (extract → publish →
both apps declare it). The promotion event *is* the discovery mechanism. `oshal-app validate` can
even detect the smell: *two packages vendoring the same module → candidate for promotion.*

### 6. The kernel API already exists — it is `AppContext`, and it is wide open

Derived evidence ([docs/apps/skill-registry.md](../apps/skill-registry.md), generated by
`scripts/skill-inventory.js`): every route factory receives `ctx`, and apps reach capabilities
through it far more than through `@/features/*` imports. **`ctx` is the de-facto kernel-skill API
— uncurated and undeclared.** So **D8 should formalize `AppContext`, not invent a new barrel.**

**And it is a live authorization hole.** The single most-used field is **`ctx.pool` — a raw
Postgres pool — handed to 20 apps.** For first-party code that is merely untidy. For a
**store-installed third-party package it is unrestricted read/write to every table in the
database**, straight through RLS-by-convention. Any skill/authorization model that does not
address `ctx.pool` is theatre.

Implication for §2 Axis B: the kernel API must be **split into a stable, package-callable
contract vs. platform internals a package may never touch**, and privileged handles (`pool`,
`swarm`, `orchestrator`) must be either withheld from third-party packages or replaced with a
scoped facade (a per-app, RLS-bound repository rather than the raw pool).

### 7. Skills may need INFRA — and that is blocked on D1

An enterprise-DB skill needs a database **server**, not just a driver. A skill package must be able to declare
`infra:` (a container/service). Packages **cannot ship compose services today** — this is the
*same* unsolved problem as **D1 (bot-container model)** in the migration plan, generalized from
bots to any package-declared runtime. **D1 must answer for skills too, not just bots.**

---

## Consequences

- **Positive:** the uninstalled-dependency-tree becomes a normal, solved package-manager problem
  (the resolver + ref-count + reverse-dep guard already exist); one-offs stay out of the kernel;
  destructive skills are governed by primitives we already enforce; the kernel stops being a
  dumping ground for "shared-ish" things.
- **Cost:** a second artifact type in the store (`type: skill`) with its own validate/install path;
  `types.ts` must finally grow the `provides`/`uses`/`dependencies.skills` fields the SDK doc
  already promises; the D1 decision widens.
- **Risk if we DON'T do this:** the first enterprise app buries its DB skill inside itself, the
  second one can't reach it, and someone "fixes" it by promoting that skill into the kernel — the
  kernel becomes a junk drawer and the whole carve-out is undone.

---

## Open questions — ALL RESOLVED 2026-07-13 (operator, via the decision slate)

Every recommendation below was taken as proposed. Resolution per item:

- **O1 → keep "skill"; ADR-089's feature is renamed "Agent-Skills import"** (rename sweep owed).
- **O2 → defer `internal`** — v1 ships `private | public`; the third tier is additive when a
  real vendor-suite case appears.
- **O3 → default visibility = `private`** (fail-closed).
- **O4 → default `callableBy` = operator-only** for skills; kernel skills declare themselves
  open explicitly (one-time declaration sweep of existing open callers owed at build time).
- **O5 → yes** — runtime placement covers skill-declared infra too; recorded in
  [ADR-093](093-packaged-app-runtime-placement.md).
- **O6 → scoped per-app RLS-bound facade** for third-party packages; first-party keeps the raw
  pool during migration; third-party NEVER receives `ctx.pool`.
- **O7 → adopt the 4-layer chain** (package default → deployment policy with lock → tenant →
  user profile) with `scope`/`lockable`/`secret` per setting; THE LINE stands (provider/model/
  harness/tool-grants = deployment-locked; voice/verbosity/goals = user; BYOK = the one
  user-scoped provider override). Secondary: collapse the 10 bespoke per-user tables into one
  RLS'd `(user_sub, app|skill, key)` store, staged per wave.
- **O8 → adopt "the payer picks", trust-scoped** — chain user BYOK → tenant key → admin-shared
  default (first-class, capped, attributed, revocable-per-app) → refuse; sandbox behaviour
  byte-identical; mechanism per the corrected two-species implementation note (§2): keys/
  endpoints ride `byoLlmConnection`, vendor OAuth logins get per-identity homes.
- **D1 (companion decision, same slate) → staged tiers, minimum framework change** — the
  operator's explicit caution — see [ADR-093](093-packaged-app-runtime-placement.md).

The original questions are preserved below for the reasoning record.

### Original questions (as put to the operator)

- **O1 — Naming.** Keep "skill" for this concept and rename ADR-089's to "Agent-Skills import"?
  (Recommended.) Or pick a fresh word to avoid touching ADR-089 at all?
- **O2 — Is `internal` (namespace-scoped visibility) worth it in v1**, or ship only
  `private` | `public` and add `internal` when a real vendor-suite case appears? (Lean: defer it —
  YAGNI until a real vendor suite exists.)
- **O3 — Default visibility for an undeclared skill:** `private` (safe, fail-closed) — confirm.
- **O4 — Default `callableBy` when undeclared:** ADR-087's current default is *open to every
  caller* (backward-compatible). For **skills**, should the default be **operator-only** (secure by
  default) instead? Kernel skills like `voice` would then declare themselves open explicitly.
  (Lean: yes — a skill is closer to privileged machinery than to a UI surface.)
- **O8 — Credential identity & cost attribution (THE GATE TO GOING PUBLIC).** Today every bot
  container mounts the *same* host `~/.codex` / `~/.claude` — **every bot authenticates as the
  operator.** Adopt "the payer picks": execution resolves the credential from the **caller**
  (user BYOK → tenant key → **admin-shared default, capped**), `chat_tasks` records **which key
  paid** (not just whose task it was), and an app may declare an inference **hint**
  (`preferredTier`) but **never a binding** (`model`/`baseUrl`/`apiKey` — that is both a
  data-exfiltration channel and the death of Token Chase).
  **Two hard constraints, both operator-stated:**
  (a) **The admin-shared default STAYS** — first-class for sandbox/family/single-tenant; the
  existing swarm's behaviour must be *identical*, just explicit, capped, attributed, and
  revocable-per-app. **Do not break the sandbox swarm.**
  (b) **BYOK is mandatory only in the public/multi-tenant mode**, where a shared personal OAuth
  is structurally impossible (ToS + cost + isolation).
  **The one new rule:** the shared default is **scoped by trust** — a third-party package does
  not silently inherit the operator's key (grant-capped / require-BYOK / deny, decided once per
  app). **Mechanism (corrected — see the two-species implementation note in §2):** per-user keys
  and endpoints ride the **already-live `byoLlmConnection` seam** (`resolveUserLlmConnection`);
  per-user vendor OAuth logins require **per-identity credential homes** (codex has the per-spawn
  home seam; claude does not) — **not** the connector token broker, whose `.oshal-cred-*` files
  the CLIs' auth machinery never reads. Nothing third-party is installable until this policy
  exists. **Packed bots are unaffected:** pack artifacts (persona + manifest) carry zero
  credential config — the persona `runtime:` block is dropped by the loader; harness comes from
  the registry, credential from the resolution chain. When the chain resolves to the admin-shared
  default, behaviour is byte-identical to today's mounts.
- **O7 — Configuration authority (Axis D).** Adopt the 4-layer chain (package default →
  deployment policy *with lock* → tenant → user profile), with every setting declaring
  `scope`/`lockable`/`secret`? And confirm the line: **provider/model/harness/tool-grants =
  `deployment`, locked** (cost + data egress); **voice/verbosity/goals = `user`**; **BYOK = the
  one legitimate user-scoped provider override, because cost accountability follows the key.**
  Secondary: collapse the **10 bespoke per-user settings tables** into one RLS'd
  `(user_sub, app|skill, key)` store the manifest `settings:` schema declares into.
- **O6 — `ctx.pool` (raw DB, 20 apps).** Do third-party store packages get the raw pool, a scoped per-app RLS-bound facade, or no DB handle at all (data only via declared skills)? This is the sharpest security question in the whole store model. (Lean: facade — first-party keeps the pool during migration, third-party never gets it.)
- **O5 — Does D1 expand** to "any package-declared infra (bot containers *and* skill services)"?
  (Lean: yes — one decision, not two.)

---

## Addendum 2026-07-17 — Skill profiles (BUILT, first slice)

The operator's design direction (2026-07-17, during the app-suites conversation): a default capability
like "audio summary" is generic — it doesn't know what a *good* summary means for the calling
app. Class notes want key concepts + homework; meeting notes want decisions + action items; an
exec-quarterly wants numbers + risks. Same engine, different pattern. Today the only way an app
teaches that is a full bot persona (little-monsters' `lecture-scribe` *is* the class-notes
pattern) — heavyweight, one bot per pattern. Skill profiles are the lighter primitive.

**What it is.** An app declares, in its manifest, a domain **pattern** for a profileable
**capability**:

```yaml
skillProfiles:
  summarize:
    pattern: class-notes
    instructions: >-
      Turn the transcript into study notes a K-12 student can revise from …
    sections: [key-concepts, definitions, formulas-and-examples, homework-and-assignments]
    outputContract: markdown study notes, concept-first
```

**Decisions (as built):**

1. **A capability is NOT a kernel skill.** `summarize` is bot *reasoning*, not an importable
   module, so it is deliberately kept OUT of `KERNEL_SKILLS` (whose invariant is "a compiled
   `distFile` exists," CI-guarded). Profiles key against a **separate closed capability registry**
   (`src/shared/skill-profiles/capabilities.ts`, `SKILL_CAPABILITIES`), never against a
   `KernelSkillId`. `skillProfiles:` keys and `uses:` ids are disjoint vocabularies — a profile is
   NOT added to `uses:`.
2. **Resolution is controller-side; the pattern rides as prompt text (ADR-036).** The bot node is a
   separate container with no registry, so the controller resolves the calling app's profile at
   **dispatch** (`dispatchManifestWorkerTicket`, keyed by `ticketType`) and composes it into the
   worker prompt via the pure `composeSkillProfilePrompt`. The LLM work still runs on the
   accountable bot and cost still lands in `chat_tasks` — **no kernel LLM call.**
3. **Lifecycle mirrors tools/schedules/guest-tier.** A shared in-memory registry
   (`src/shared/skill-profiles/registry.ts`, modeled on `guest-capability-matrix`) is written by
   `activate()` (`applySkillProfiles`) and cleared by `deactivate()` — replace-by-app (idempotent),
   full teardown on toggle-off/uninstall so an inactive app holds zero live profiles.
4. **Validation is fail-closed** at manifest load: unknown capability key, non-map shape (YAML
   null / list), or a stub profile (empty `pattern` or `instructions`) all throw.
5. **The persona stays.** Profiles make the pattern *declared*, not deleted — `lecture-scribe`
   still runs its full pipeline; the block just makes the notes shape a first-class manifest datum
   that the dispatch path reinforces.

**Proven by two consumers, one capability — each on its OWN live path:** little-monsters
(`class-notes`) applies its profile on the **education ticket** path (`dispatchManifestWorkerTicket`
resolves by `ticketType`); email-summarizer (`email-digest`) ships **no schedules**, so its profile
applies at its **interactive summary chokepoint** — `email-routes.ts` `runOnBot('summary', …)`
resolves by app name (`resolveSkillProfileByApp`) and composes the pattern before the bot runs. Both
paths are ADR-036-safe (pure text composition; the LLM work + cost stay on the accountable bot). The
unit spec (`tests/unit/skill-profiles.spec.ts`) proves the same capability composes distinct,
domain-appropriate prompts for the two profiles.

**Two injection sites today, one generalization pending.** Injection is wired where each shipped
consumer actually summarizes: the manifest-worker **ticket** dispatch (`dispatchManifestWorkerTicket`,
by ticketType) and the email **interactive** chokepoint (`runOnBot`, by app name). What is NOT yet
generalized: an arbitrary app's `BotNodeClient.execute` / inline-concierge call does not
automatically carry its profile — that needs a dedicated `BotNodeRequest.pattern` carrier threaded
`execute → /api/swarm-execute → envelope.payload → bot-node-execution-handler` (injected in both the
layered and direct prompt branches). Until then, a new app wanting interactive profile injection wires
its own chokepoint the way email does. Tracked in [BACKLOG.md](../BACKLOG.md).
