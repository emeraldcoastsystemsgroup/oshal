# OSHAL — As-Is / To-Be State & Delivery Plan

**Status as of 2026-06-16.** This document is the *honest* state — it distinguishes
**built** (code exists, type-checks, committed), **live** (baked into the running image
and serving), and **connected** (a user has completed OAuth and a token is stored). A
thing can be live but not connected.

Companion: [oshal-capabilities-brief.md](oshal-capabilities-brief.md) (sales/exec view).

---

## 0. Demo-ready snapshot (2026-06-16) — what's live + verified

The catalog (`/applications`) — working apps, all loaded + active:

| App | What it does | Verified |
|---|---|---|
| **Social** | AI-draft → approve → publish to LinkedIn / X / **Facebook Pages**; **Signals** tab = inbox-fed social feed + AI organize; Composer; Studio | FB page post→delete ✓; Signals served from store ✓; X 402-gate ✓ |
| **Intelligent Communication** | email read/triage on the comms bot (token-broker, no master key) | live |
| **Storage** | **Assistant** (chat-ops: "make me a repo", "save files to Dropbox", "where do files save?") · Settings (Code/Files → GitHub/Dropbox/local) · My Files browser | assistant NLU round-trip ✓; prefs read ✓; Dropbox CRUD ✓ |
| **Presentations** | topic → AI outline → real **.pptx** → saved to Files target (Presenton replacement) | render→save→download intact ✓ |
| **Codex Packer** | describe a process → packs a self-contained bot/swarm (download or deploy) | deploy verified earlier |
| **Little Monsters** | education app | live |
| **DevOps + Vault** | **Private Preview** facade — premium tier (Vault-brokered cloud creds), badged, no live infra | facade live (ADR-040) |

Connectors (all live in the hub, grouped by purpose): Google ×2 ✓, LinkedIn ✓, X ✓, Facebook login ✓,
**Facebook Pages (Business)** ✓ (page listed via /me/accounts), **GitHub** ✓, **Dropbox** ✓.

Background: the **inbox-ingest cron** (15 min) captures all new Gmail → `oshal_inbox_messages`
(timestamped, categorized, deduped) → Social Signals + (future) digest read from the store.

Security: token broker (master key off bots) ✓ · cred wipe-on-completion ✓ · per-user pack
isolation ✓ · DEK envelope crypto built (flag-off) · per-provider connector-token encryption ✓.

LLM: 42 embedded providers (run under the Cline wrapper — no harness wrappers); roster + configured
status visible in Utilities → "LLM providers". Claude Code login works remotely.

**Deferred polish (none demo-blocking):** UI key-entry for LLM providers (keys via `.env` today) ·
a dedicated data-mgmt bot node (NLU runs on the comms bot, works) · mesh/selector sensing (for the
stock-trading-trigger feature) · oshal-engineering screen design refresh · capture-crm same-origin
board (bot kept, dead external surface removed).

---

## 1. As-Is state

### 1.1 Connectors hub

OAuth connect to a user's own accounts; tokens encrypted at rest (AES-256-GCM), one row
per `(user_sub, provider)`. All providers below are **live in the hub**; the right column
is whether *this operator* has completed the connect (token stored).

| Provider | Capability | Live | Connected (operator) |
|---|---|---|---|
| Google (×2 accounts) | Gmail + Calendar read | ✅ | ✅ |
| LinkedIn | sign-in + post (`w_member_social`) | ✅ | ✅ |
| X / Twitter | post (`tweet.write`) | ✅ | ✅ (post scopes only) |
| Facebook (login app) | basic profile | ✅ | ✅ |
| Outlook / M365 | mail + calendar read | ✅ | ⬜ |
| **GitHub** | repo read/write + identity | ✅ | ⬜ *(redirect fixed; connect not completed)* |
| **Dropbox** | files read/write (file-space backend) | ✅ | ⬜ *(redirect fixed; connect not completed)* |
| **Facebook Pages (Business)** `meta-business` | Page streams + publishing | ✅ | ⬜ *(needs a FB Page to exist)* |

**Known config note:** the deployment's `APP_URL` is `littlemonster.example.com`,
but the OAuth apps were registered under `oshal.example.com`. Per-provider redirect
overrides (`GITHUB_/DROPBOX_/META_BUSINESS_REDIRECT_URI`) reconcile this. Each provider's
console must list the exact `oshal.example.com/api/connect/<provider>/callback`.

### 1.2 Social swarm

- **Composer** (`/api/social/composer`) — AI-drafts a post on the comms bot (cost
  captured in `chat_tasks`), you refine, then **publish to LinkedIn or X** inline
  (deterministic, no LLM in the publish path, exact approved text). **Live + usable.**
- **Facebook Pages** (`/api/social/facebook`) — page selector → live **stream** (feed
  with reactions/comments/shares) → **publish box**. **Live**; shows a "create a Page"
  empty state until the operator has a Facebook Page. Backend routes:
  `GET /facebook/pages`, `GET /facebook/pages/:id/feed`, `POST /facebook/pages/:id/post`.
- **Content Studio** — personal-branding engine: trends + news → perspective drafts.
  **Live.**

### 1.3 Storage / file-space

- **GitHub + Dropbox connectors** built and live (see matrix). Dropbox is the intended
  **per-user file-space backend** (user owns the data).
- **Per-user pack isolation** — codex-packer output is scoped to `packs/<sha256(sub)>/`;
  no user can list/download/deploy another user's packs. **Built + live.**
- General quota'd local file space (250 MB) + upload/download UI — **not built**.

### 1.4 Swarm packer

- `codex-packer` interviews an operator and emits a single-purpose bot or multi-bot swarm
  → **download as zip** or **deploy live** (new ticket type + isolated queue, survives
  restart). **Built + live.**

### 1.5 Security posture (the sellable core)

| Control | State |
|---|---|
| Per-user encrypted connector tokens (AES-256-GCM, scoped to caller `sub`) | ✅ Live |
| **Token broker** — `SESSION_SECRET` removed from bot containers; bots get short-lived per-user tokens from the controller; master key + OAuth secrets scrubbed from every bot spawn env | ✅ Live + verified |
| **Per-user DEK envelope encryption** — each user's tokens under their own data key, wrapped by a master KEK; no single key decrypts all | ✅ Built, **gated OFF** (`OSHAL_ENVELOPE_CRYPTO`), 4 unit tests pass, backward-compatible |
| Per-user pack isolation | ✅ Live |
| Auth-gating opt-in per route (`requiresAuth`) | ✅ Established pattern |

---

## 2. To-Be state (roadmap)

| Item | Target | Notes |
|---|---|---|
| **GitHub + Dropbox connected** | Operator completes OAuth; tokens stored | Plumbing done; just the connect click + each console's redirect URI |
| **Facebook Pages live** | Operator creates a Page → reconnect → streams + publishing flow | FB API can't post to a personal timeline; a Page is mandatory |
| **Activate envelope crypto** | `OSHAL_ENVELOPE_CRYPTO=true` + rebuild + live-verify | Tokens upgrade to `v2:` on next write; format-aware decrypt means no migration downtime |
| **X follow / growth** | `follows.write` scope (added) → reconnect X → build follow endpoint | ⚠️ Follow endpoint likely needs a **paid X API tier**; Free is post-only |
| **Per-user file space** | 250 MB quota + upload/download UI, swarm→storage write path | Pack isolation already establishes the per-user layout |
| **DevOps / Vault swarm** ⭐ | Privileged runtime: `vault-bot` + `vault-tool` pull short-lived scoped cloud creds (AWS STS) per task; dynamic config registration; controlled-cred injection reusing the token-broker channel; session wiped after | The "AWS creds, great results when controlled" loop, productized. Security-reviewed pass. |
| **Databricks connector** | Enterprise data domain | Deferred until a data-swarm needs it |
| **All-local swarm profile** | Repeatable Ollama/LM-Studio/LiteLLM-only bundle | Roadmap |

---

## 3. Delivery next steps (prioritized)

### Immediate — operator actions (no engineering)
1. **Finish GitHub connect** — click Connect in the hub, complete authorize. Confirm a
   `github` row lands in `oshal_connections`.
2. **Finish Dropbox connect** — ensure the Dropbox console lists
   `https://oshal.example.com/api/connect/dropbox/callback`, then Connect.
3. **Facebook Pages** — create a Page at facebook.com/pages/create, register
   `…/api/connect/meta-business/callback` in the Meta Business app, then Connect.
4. **X follow prerequisites** — set App permissions to *Read and write*, reconnect X to
   grant `follows.write`, and confirm the X API **tier** supports follows.

### Near-term — engineering (small, bounded)
5. **`POST /api/social/twitter/follow`** — follow-by-handle endpoint (resolve handle →
   id → follow as the connected user). Gate on tier; surface a clear error if `403`.
6. **Activate envelope crypto** — flip `OSHAL_ENVELOPE_CRYPTO=true`, rebuild, verify a
   live connector still reads and new writes are `v2:`.
7. **Per-user file space** — 250 MB quota store + a minimal upload/download surface;
   wire a deployed swarm's output to the user's GitHub/Dropbox.

### Strategic — the big build
8. **DevOps / Vault swarm** — the privileged runtime + Vault credential broker. This is
   the highest-value next bundle and needs a dedicated, security-reviewed effort. Reuse
   the existing token-broker channel for cred injection; build the ephemeral
   single-user/wipe-after lifecycle first, then the hypervisor/Terraform tooling.

### Delivery / operability gates
- Every handover must be **human-operable from `localhost`** with `MOCK_OIDC=true` (no
  unavailable external services).
- Connector creds and `SESSION_SECRET` stay out of git (`.env` is gitignored) and out of
  bot containers.
- Docs describe **what works today**; vision lives in `ROADMAP.md` / `BACKLOG.md`.

---

## 4. One-paragraph executive summary

OSHAL is a working multi-agent platform with a live connector hub, a social/personal-
branding swarm that already drafts-and-publishes to LinkedIn and X, an email-triage
swarm, a process-to-bot packer, and a per-user security model (token broker live,
envelope encryption built and ready to switch on). The immediate path to a clean demo is
finishing three OAuth connects (GitHub, Dropbox, Facebook Pages) and creating a Facebook
Page; the next engineering increments are the X follow/growth endpoint and per-user file
space; and the strategic build is the **DevOps/Vault swarm** — the controlled
"real-credentials, real-results" loop that is OSHAL's biggest differentiator.
