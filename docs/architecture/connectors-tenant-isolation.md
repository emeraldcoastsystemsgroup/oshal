# Connectors hub & per-user isolation (as-built)

How OSHAL keeps two concurrent users from seeing each other's data — across both
**identity** (whose external accounts/tokens) and **context** (whose conversation
and workspace). This is the single-tenant baseline that the SaaS tenant layer
([ADR-035](../adr/035-multi-tenant-saas-foundation.md)) builds on top of.

> Validated end-to-end 2026-06-14 with two live connectors (Google + Facebook) for
> a single operator. The two isolation axes below are independent — both must hold
> for safe multi-user operation.

## Two independent isolation axes

| Axis | Boundary key | What it protects |
|---|---|---|
| **Identity** (which external account acts) | `user_sub` (OIDC subject) | whose Gmail/Calendar/Facebook a bot reads/writes |
| **Context** (which conversation/files) | `taskId` (per-conversation UUID) | whose chat history + workspace a request sees |

A bot is a **single shared process** (one container per bot type — not one per user).
Isolation comes entirely from these two keys, not from process separation.

## Identity: the connectors hub

[src/app/routes/connectors-routes.ts](../../src/app/routes/connectors-routes.ts) — per-user
incremental OAuth, separate from sign-in.

- **Caller identity** comes from the OIDC session (`req.oidc.user.sub`), not from
  anything the client can supply — see `caller(req)`.
- **Storage** is keyed per user: `oshal_connections` has `UNIQUE (user_sub, provider)`,
  and connects are `INSERT ... ON CONFLICT (user_sub, provider) DO UPDATE`. Each user's
  token is a **separate row** under their own sub.
- **Every read is sub-scoped**: list / token / refresh / delete all filter
  `WHERE user_sub = $1 AND provider = $2` with the session sub. There is no code path
  where one user's request reads another user's row.
- **Tokens are encrypted at rest** — AES-256-GCM, key derived from `SESSION_SECRET`.
- **The per-user token accessor** is `getValidAccessToken(pool, userSub, provider)`
  (refresh-capable). **This is the only correct way for a bot to fetch a user's token.**

**Scope policy.** Provider scopes are env-overridable so access can expand without a
code change: `FACEBOOK_SCOPES` and `GOOGLE_CONNECT_SCOPES` (space/comma-separated).
Defaults are least-privilege (Google: Gmail+Calendar **read-only**; Facebook:
`public_profile`). Expanding to act (`gmail.send`, `calendar.events`) works for the
app owner immediately but needs provider verification before other users can grant it.

### Honest limits of the identity layer

- Isolation is enforced at the **application/session layer** (sub-scoped queries) **and,
  as of 2026-06-27 (ADR-076), at the database layer**: `oshal_connections` (and all other
  owner/tenant-bearing tables) now have `FORCE ROW LEVEL SECURITY` policies, and the runtime
  connects as the non-superuser `oshal_app` role. A query bug can no longer cross users at the
  database layer for any enforced table — the app-layer scoping is now a defense-in-depth
  duplicate of the DB guarantee rather than the sole boundary.
- The encryption key is a **single shared `SESSION_SECRET`**, not a per-user key.
  Strong against a normal user reaching another's data; **not** a per-user vault —
  anyone holding both DB access and `SESSION_SECRET` could decrypt all rows.
  A per-user DEK envelope (`src/app/routes/connector-token-crypto.ts`) is **built and
  tested but OFF by default** (`OSHAL_ENVELOPE_CRYPTO`); when enabled it closes this
  exact gap. See the Envelope-crypto row in [SECURITY-POSTURE.md](../security/SECURITY-POSTURE.md).

## Context: the `taskId` boundary

Everything a conversation touches is keyed by `taskId`:

- **Conversation history** — SQLite, `SELECT/INSERT ... WHERE task_id = ?`
  ([any-bot/server/stores/MessageStore.js](../../any-bot/server/stores/MessageStore.js)).
- **Workspace** — one directory per task: `/app/swarm-workspace/{taskId}/`
  ([any-bot/server/controllers/TaskController.js](../../any-bot/server/controllers/TaskController.js)).
- **In-memory task object** — `activeTasks` Map keyed by `taskId`.

The live chat UI mints a **`crypto.randomUUID()`** taskId per conversation
([src/pages/chat/ui/chat.html](../../src/pages/chat/ui/chat.html),
[chat-config-modal.mjs](../../src/pages/chat/ui/chat-config-modal.mjs)), reused only when
a saved conversation is reopened via `?taskId=`. So two different users in two browsers
get **different taskIds** → different history rows, different workspace dirs, different
Map entries. Node's single-threaded async model interleaves their requests safely
because neither shares mutable state with the other.

### When context IS shared — by design

The **multi-agent ticket workflow** runs several *agents* in one ticket's shared
workspace so they can collaborate. Each agent still gets its own `{agentId}-context.md`
persona file. This is cooperation between agents on one ticket — **not** two human users
crossing. It does not apply to separate users in separate chats.

### Footguns (two fixed 2026-06-14, one open)

- **Fixed** — `chatService.ts` minted `task-${Date.now()}` (collides if two users send
  in the same millisecond). Now uses `crypto.randomUUID()`. (Legacy helper; the live
  path already used a UUID.)
- **Fixed** — `scripts/oshal-gmail.js` previously read the *newest* Google connection
  when `GMAIL_ACCOUNT` was unset. It now **fails closed** (exit 2) when more than one
  Google connection exists, forcing the caller to name the account. See open item below.
- **Open** — the `activeTasks` task object is not defensively copied on read; safe today
  because different users hold different taskIds, but a *deliberately shared* taskId
  (e.g. a future shared-conversation feature) would bleed. Add per-taskId mutex /
  copy-on-read before introducing shared conversations.

## The rule for bots that act on a user's behalf

Context isolation (`taskId`) and identity isolation (`user_sub`) are **separate**. A bot
must satisfy both:

1. It runs inside the requesting conversation's `taskId` (handled by the dispatch path).
2. It must fetch tokens for the **requesting user's `user_sub`** via
   `getValidAccessToken(userSub)` — never "newest connection".

The deeper wiring (propagating the requesting user's `sub` all the way into bot
execution so the email-bot can pass the right `GMAIL_ACCOUNT`) is **not yet built** —
tracked in [BACKLOG.md](../BACKLOG.md). Until then, multi-user email automation must
pass the account explicitly; the fail-closed guard above prevents a silent wrong-mailbox
read in the meantime.
