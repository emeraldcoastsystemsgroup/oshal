# ADR-064 — Free-tier LLM access: a compliant token bank, not pooled signup credits

## Status

Accepted — connect + rotation API BUILT 2026-06-21 (type-checks clean). The decision on *how*
the platform offers users free runs. The instant on-ramp (pooled-Codex "free shared model")
already exists; this ADR scopes the durable free tier and rules out the naive approach.

**Built (`src/app/routes/free-tier-*.ts`, mounted `/api/connect/free-tier`):** a provider
catalog (OpenRouter, Gemini/AI Studio, Groq, Cerebras, Mistral — all OpenAI-compatible, all
Cline-native ids); validate-on-save connect (fail-closed round-trip) reusing the per-user
AES-GCM connector store; OpenRouter PKCE OAuth connect; LRU rotation with a per-connection
rate-limit cooldown table (`oshal_free_tier_state`); and the Cline-handoff seam
`getFreeTierConnection()` → `freeTierToHarnessConfig()` returning the `buildClineProvider` shape.

**Execution wiring BUILT 2026-06-21:** `resolveUserLlmConnection(pool, sub)` is the per-request
resolver — the user's explicit bring-your-own endpoint wins, else a *probed-live* free-tier
rotation pick (`resolveLiveFreeTierConnection`: probe with a 1-token call, and on 429/402/403
cool the key down via `reportRateLimit()` and advance to the next eligible connection). It returns
the OpenAI-compatible `{baseUrl, apiKey, model}` the execution handler already runs as
`byoLlmConnection` (routed through Cline / the OpenAI provider, ADR-005) — so no handler change.
Wired into the agentic bot routes that thread a per-user connection: **email, finance, security,
trading**, and the live **Jarvis** turn (`runJarvisBot` → `botClient.execute`, the only live Jarvis
LLM dispatch; the legacy `orchestrate`/`delegateOne` path is dead code). Returns `undefined` when the
user has no connections → falls back to the bot's configured provider, so it is purely additive.

**Platform fallback key (invisible default, opt-in):** `platformFreeConnection()` reads the operator's
own `OPENROUTER_API_KEY` from env and, as the LAST step in `resolveUserLlmConnection` (after the user's
own BYO + free-tier picks), hands it back pinned to a free model (`OPENROUTER_FREE_MODEL`, default a
`:free` model so the shared key can't accrue spend). So a user who has connected nothing still runs for
free by default, never sees the key, and a user's own key always wins. Off unless the env var is set;
the key lives only in the gitignored `.env`/secret store, never committed (canonical name is
`OPENROUTER_API_KEY` — not `OPEN_ROUTER_KEY`). `platformFreeConnection()` PROBES + rotates a list of
`:free` models rather than pinning one, because the free catalog churns (delist/paid/rate-limit);
verified live 2026-07-08 after a single pin (`llama-3.3-70b:free`) had gone 429 and two coded free
models had 404'd.

**Hardened 2026-07-10 (`d4f27a38`, live-hit incident):** two behavior changes after the shared key
hit the 50/day wall and every Jarvis turn + scheduled trading-analyst leg 429'd all morning.
(1) **Walled key → `null`, never a dead connection:** when every candidate model probes
rate-limited (the daily cap is ACCOUNT-wide, so all `:free` models 429 together),
`platformFreeConnection()` now returns `null` so the caller falls back to the bot's configured
provider — the old "first candidate unprobed" fallback handed back a guaranteed-dead
`byoLlmConnection` that blocked that fallback. Probe verdicts are cached in-memory (live 10 min /
walled 15 min) because the probes are real 1-token completions that burned ~6 of the 50/day quota
per resolution. (2) **The OPERATOR skips the free-tier legs entirely** (an explicit BYO endpoint
still wins if set): the swarm's default BYOK login (mounted claude/codex OAuth) is the operator's
own subscription, so the free tier exists to keep OTHER users off it — not to downgrade the
operator onto `:free` models. Interactive turns use the ambient request identity (`isOperator`);
background and scheduled runs (no request identity) use the `OSHAL_OPERATOR_SUBS` allowlist. Both
behaviors are pinned by `tests/unit/free-tier-operator-exemption.spec.ts`.

**Operator cost note — the $10 catch:** OpenRouter caps `:free` models by the account's LIFETIME
credit purchase — **under $10 = 50 `:free` requests/day; $10+ = 1,000/day** (20/min either way;
[openrouter.ai/docs/api-reference/limits](https://openrouter.ai/docs/api-reference/limits)). A ~30-bot
swarm exhausts 50/day almost instantly, so the shared fallback on a **zero-credit** key is demo-only.
Making "free by default" real needs a **one-time $10** on the shared account (credit, not a
subscription; `:free` still costs $0 — the $10 only lifts the daily ceiling). Each user connecting
their own key gets their own limit, so the shared key is the zero-setup **floor**, not the ceiling.
Tracked in [BACKLOG](../BACKLOG.md).

**Generalized to other shared read-only services.** The same "one operator key serves everyone,
personal connect is optional" pattern applies beyond the LLM: **TMDB** (Movies & TV catalog,
`THEMOVIEDB_*`) and **Duffel** (Travel flight search, `DUFFEL_ACCESS_TOKEN`) resolve a per-user/tenant
token else an env key, and `/api/connect/list` exposes `platformDefault: true` (from `PLATFORM_DEFAULT_ENV`
in connectors-routes) so Utilities labels those cards "Optional — shared key active" instead of as
required setup. This only fits **shared read-only catalogs**; connectors that read a user's OWN account
(Gmail, Slack, Spotify, Walmart/Uber, Square/PayPal, Dropbox, SmartThings, finance, GitHub/Notion) stay
per-user — no shared key. Candidate not yet keyed: Google Programmable Search (`GOOGLE_SEARCH_API_KEY`).

**OpenRouter OAuth verified** against the OAuth-PKCE docs 2026-06-21 (`authUrl` + `POST
/api/v1/auth/keys` with `{code, code_verifier, code_challenge_method:S256}`, response `{key}`). One
constraint: OpenRouter accepts callback URLs only on HTTPS:443/3000 or any localhost port, so the
one-click flow needs a conforming public origin; paste-key is the always-works fallback.

**Deferred (documented seam, not a gap in rotation):** rate-limit detection is a pre-flight probe at
dispatch, which is what makes rotation skip a walled key. Catching a *mid-run* 429 from inside the
spawned Cline CLI and feeding it to `reportRateLimit()` would require carrying `connectionId` on the
shared `byoLlmConnection` shape and intercepting the any-bot provider error — a cross-boundary change
not worth its risk yet. The seam (`reportRateLimit`, and `connectionId` from `getFreeTierConnection`)
is ready when that's prioritized.

## Date

2026-06-21

## Related

- [ADR-005 (Cline/CLI as the only LLM call path)](005-cline-cli-only-provider.md) — and
  [ADR-020 (OpenAI Codex runtime provider wiring)](020-openai-codex-runtime-provider-wiring.md):
  the existing free shared model rides the pooled Codex CLI login.
- [ADR-033 (Multi-Harness Execution Framework)](033-multi-harness-execution-framework.md) — the
  provider/harness abstraction a tier router plugs into.
- [ADR-049 (OSHAL as an aggregation platform)](049-oshal-as-aggregation-platform.md) — "commoditize
  below, own the user"; a free tier is part of owning the front door.
- Onboarding LLM gate (built 2026-06-19): first-run `GET /` → `/welcome` when no active LLM, a free
  shared model on pooled Codex creds (keys never shown), and Codex `auth.json` import.

## Context

The idea raised: "lots of places offer free tokens — can we collect those and run the platform on
them, or build a bank of free tokens a user signs up for so they can run for free?"

The literal version — sign up for many providers' free-tier credits and **pool them to serve all our
users** — is the one approach to avoid. Nearly every provider free tier (OpenAI, Anthropic, Gemini,
Groq, etc.) prohibits sharing one account's credits across many end-users or reselling/multi-tenant
use. It works until a provider notices, then the account is flagged and the "bank" is gone. It is not
a foundation to build a product on.

But a real free tier *is* achievable. Two hard constraints from the owner decide the shape:

1. **We cannot be the always-on backstop.** A model that depends on our own compute/uptime to serve
   everyone is not sustainable for a one-person operation. Anything that makes our availability the
   ceiling on the free tier is out as the *default*.
2. **Every provider already hands free tokens to *each user*.** The free credits exist — they're just
   issued per-account, to the user, not to us. The unlock is to use the user's own free allotment
   across *many* providers, not to pool one account's credits into a shared bank.

That reframes the "bank of free tokens": the bank is **the user's own collection of free-tier keys
across every provider**, and the platform's job is to make connecting them trivial and to **rotate
across them** so the user squeezes maximum free throughput before anything costs anyone money.

| Path | Free to user | Cost/effort to us | Sharp edge |
|------|-------------|-------------------|------------|
| **BYO free tiers, multi-provider, rotated** (default) | yes | none — no compute, no shared account | one-time per-provider connect; per-key rate limits (mitigated by rotation) |
| Pooled-Codex free shared model | yes | our account, capacity-capped | bootstrap convenience only; can't scale to everyone |
| Swarm-hosted open models | yes | our compute + uptime | makes our availability the ceiling — optional, not default |
| Pooled public free endpoints | yes | cheap | rate-limited; some ToS forbid multi-tenant even on free tier |

## Decision

Make **bring-your-own free tiers across many providers, rotated by the platform**, the default free
tier. **Never** pool one account's signup credits into a shared bank, and **do not** make our own
always-on compute the thing everyone depends on.

### 1. Default free tier — the user's own multi-provider free tiers, rotated

On (or just after) signup, guide the user to connect their own free-tier accounts across providers
that offer them — Gemini, Groq, OpenRouter `:free`, Cerebras, Mistral, Codex `auth.json` (already
supported), etc. The platform stores each as the user's own credential and **rotates across them**:
when one hits its free rate/quota limit, route to the next. The user's "bank" is the *sum of every
provider's free tier they've connected*, which is large and costs neither them nor us anything. This
respects both constraints — no shared account to get banned, and our uptime is not the ceiling.

### 2. Instant on-ramp — keep the pooled-Codex free shared model, capacity-capped

The existing free shared model (pooled Codex CLI login, keys never shown) stays as the zero-config
"try it before you connect anything" front door, so first-run users see something work immediately.
It is a *bootstrap convenience on our account*, explicitly capacity-capped, and the welcome flow
nudges users to connect their own free tiers (path 1) for real throughput — it is **not** meant to
support everyone all the time.

### 3. Make connecting free tiers as frictionless as possible

The one real cost of path 1 is the per-provider signup/connect step. Lower it with a guided "connect
your free models" wizard, a running "free capacity connected" tally, and the right connect mechanic
**per provider** — because they are not the same:

- **OAuth-connect where the provider provisions a key.** OpenRouter supports an OAuth (PKCE) flow:
  redirect to its auth page → user approves → exchange the code for a scoped API key (no manual
  paste), which reaches its `:free` models. This is the closest to true one-click; do it first.
  *(Verify the current OpenRouter auth/exchange endpoints before wiring — that flow has changed.)*
- **Deep-link-and-paste everywhere else** (Gemini / Groq / Cerebras / Mistral): these are API-key
  based with no OAuth delegation. Deep-link the user straight to the provider's key page and have
  them paste the key back. Also accept Codex `auth.json` import (already supported).

**The Google-login clarification (important, and counter-intuitive):** "Sign in with Google" is
*identity only* (`openid email profile`) — it does **not** grant the user's Gemini free tier. The
free Gemini quota lives behind a Google **AI Studio API key** (separate, tied to a GCP project);
there is no login scope that hands it over. The only OAuth path that calls Gemini — **Vertex AI**
with `cloud-platform` — bills the user's GCP project and needs billing enabled, so it is **not** the
free tier. What the Google login *does* buy us: the user is already authenticated at Google, so the
deep-link to `aistudio.google.com/apikey` is a ~2-click create-and-paste rather than a full signup.
Treat Gemini as paste-a-key (fast because of the existing Google session), not as auto-granted.

The more providers a user links, the more free headroom rotation gives them — make that visible so
connecting more feels worth it.

### 4. Optional, not default — swarm-hosted open models

Open-weight models on our own / donated worker nodes (the OSHAL Node desktop worker already exists)
remain available as an *optional* zero-key fallback, but explicitly **not** the default, precisely
because they make our compute/uptime the ceiling — the constraint we are designing around. Good for a
user with no connected providers, or as community-donated capacity; never the thing we promise to keep
up for everyone.

### 5. Fallback only — genuinely-free public endpoints with failover

Endpoints *designed* for free public use (OpenRouter `:free`, Groq free, Cerebras free, Google AI
Studio free tier) may sit in the rotation as a shared fallback **only** where their ToS confirms they
allow serving our users. Treated as a "last resort" slot, never the workhorse.

### 6. Tier routing + rotation lives behind the existing provider abstraction

The connect / rotate / fall-back selection is a routing concern on top of the multi-harness framework
(ADR-033) and the LLM gate, so adding or retiring a provider is a config edit, not a rewrite. Rotation
state (which keys are rate-limited, when they reset) is per-user.

## Consequences

- A user runs for free on **their own** free tiers across many providers — credits the providers
  already give them — so the free tier scales with users instead of with our spend or our uptime.
- The owner is not the backstop: no shared account to get banned, and our availability is not the
  ceiling on anyone's free usage. The pooled-Codex model is a small bootstrap, not a promise.
- The "bank of free tokens" is reframed from *aggregating other people's credits into one account*
  (fragile, non-compliant, our liability) to *each user's own multi-provider free allotment, rotated*
  (compliant, durable, scales itself).
- Directly answers the hosted-demo cost/abuse gate (ECSG `DEMOS-BACKLOG.md` item 2): public demos can
  ask the visitor to connect a free tier (or use the capped bootstrap) instead of spending real money
  on personal CLI logins / Anthropic keys.

**Risks / sharp edges:**
1. **Connect friction** — path 1's only cost is the per-provider signup/connect step; if the wizard
   isn't dead simple, users stall on the capped bootstrap and we're back to being the backstop. The
   connect flow is the make-or-break.
2. **Per-key rate limits** — individual free tiers are small; the value is in rotation across many.
   Rotation needs solid per-user state (which key is limited, when it resets) or the user hits walls.
3. **Credential custody** — we now hold many users' provider keys; they must be encrypted at rest,
   never shown back, scoped per-user, and revocable (consistent with the data-access broker posture).
4. **ToS drift on the fallback pool** — public free endpoints change terms; the shared-fallback list
   needs periodic re-check, and anything ambiguous stays off by default.
5. **Bootstrap abuse** — the capped pooled-Codex tier needs per-user rate/spend caps and the same
   auth as everything else, since it does spend our account.

## Deferred

- The provider-rotation router (per-user key state, rate-limit detection + reset tracking, ordering).
- The "connect your free models" wizard: per-provider deep links, paste-key + `auth.json` import, and
  a visible "free capacity connected" tally.
- Encrypted per-user multi-provider credential storage + revoke UX.
- A confirmed, ToS-checked allowlist for the shared public-endpoint fallback slot.
- Optional swarm-hosted open models and donated/community worker capacity as a no-key fallback.
