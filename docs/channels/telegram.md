# Telegram channel — message your swarm

Talk to your oshal assistant from a Telegram chat. An inbound message runs on the accountable
Jarvis bot with **your** connectors and cost tracking — Telegram is just the surface.

## What runs where

```
Telegram  ──POST──▶  /api/channels/telegram/webhook   (secret in header; controller: channel I/O only)
                         │  resolve (telegram, chat) → user_sub
                         ▼
                     Jarvis bot  (BotNodeClient.execute → cost in chat_tasks)
                         │
Telegram  ◀──sendMessage──┘  reply in-channel
```

The controller never calls an LLM — it receives the update, resolves which user linked the chat, and
dispatches to the accountable bot, exactly like the cockpit does.

## Operator setup (one time, ~2 minutes)

1. In Telegram, message **@BotFather** → `/newbot` → pick a name + a username ending in `bot`.
2. BotFather returns an **HTTP API token** (`8123456789:AAH…`). Set it on the controller:
   ```
   TELEGRAM_BOT_TOKEN=8123456789:AAH...
   ```
   Register it under the business email per the partner-app-registration rule; this is the single
   shared demo bot (per-user BYO-bot tokens are a documented follow-up).
3. Point Telegram at this deployment (signed in, once):
   ```
   POST /api/channels/telegram/register-webhook   { "baseUrl": "https://oswarm.ai" }
   ```
   `baseUrl` defaults to `APP_URL` when omitted. This calls Telegram `setWebhook` with a
   `secret_token` derived from the bot token; Telegram echoes it on every delivery and the webhook
   rejects anything without it. The secret travels ONLY in that header — never in the URL, which
   would persist it to access/audit logs on every delivery.

## How a user connects (self-serve, from the cockpit card)

1. Sign in to the cockpit and open **Chat channels** (left rail under the platform tools, or
   Settings → Chat channels). *Screen:* under "Your channels", a **Telegram** card with the pill
   **available** and `Bot: @<bot username>`. "not set up" means the operator step above is not done.
2. Click **Link my Telegram**. *Screen:* a code panel with **Open Telegram and connect** (the
   `https://t.me/<bot>?start=<code>` deep link), a **Copy** button, and a countdown — the code is
   one-time and works for 15 minutes. Behind the button is `POST /api/channels/telegram/link`.
3. Click **Open Telegram and connect**. Telegram opens the bot and sends `/start <code>` for you
   (on a phone this switches to the Telegram app; on a desktop it may ask which app opens the link).
   If the link does not open, message the bot yourself with `/start <code>`.
4. *Reply:* `✅ Connected.` — the bot has bound **(telegram, that chat) → your sub**. From then on
   just message the bot and the swarm answers. The card's **Linked accounts** list shows the chat
   with an **Unlink** button.

Replies that mean something else: `That link code is invalid or expired` (older than 15 minutes,
already used, or minted for another channel — click **Link my Telegram** again), `This chat isn't
linked to an oshal account yet` (send the code from this chat first), `This chat was connected before
oshal recorded which sign-in it belongs to` (a pre-#841 link — link again from the card; the re-link
repairs it), `already connected to a different oshal account` (that account unlinks it first).

`GET /api/channels` lists a user's linked channels + whether the bot is configured;
`DELETE /api/channels/telegram/:channelUserId` unlinks one (owner-scoped).

## Isolation

The `(provider, channel_user_id) → user_sub` binding is the boundary. A shared bot routes each DM to
the correct linked user; an unlinked chat only ever gets linking instructions — never another user's
data. Every link read/write is user_sub-scoped (`ChannelLinkService`), each `update_id` is claimed
once before a bot turn, and a chat already bound to one user is never moved by another user's code.

Every refusal (unlinked chat, invalid/expired/other-provider code, refused rebind) is written to the
refusal ledger under a pseudonymous actor (`channel:telegram:<truncated SHA-256>`), never the raw
Telegram id; the rows are visible to operators only. Locally tested over the real webhook and a real
PostgreSQL (`tests/unit/chat-channel-inbound-postgres.spec.ts`,
`tests/unit/chat-channel-denial-audit.spec.ts`); the AI Test Lab card `channel-inbound-round-trip`
runs the flow on a deployment with the bot turn and the Telegram send doubled.

## Limits (honest, v1)

- **Single shared demo bot.** One `TELEGRAM_BOT_TOKEN` serves everyone who links. Per-user BYO-bot
  tokens (so each user runs their own bot) are the documented follow-up.
- **Private chats only.** Group/supergroup/channel messages are ignored — the link is keyed by the
  SENDER while replies go to the CHAT, so a linked user posting in a group would otherwise have
  their private swarm reply delivered into the group.
- **Text only.** Photos/voice/files are ignored in v1.
- **Context is per chat.** The conversation task id is stable per Telegram chat, so follow-ups
  land in the same context; a very long chat accumulates history.
- **Public reachability.** Telegram must be able to POST to the webhook, so the controller needs a
  public HTTPS origin (the Cloudflare tunnel already provides one).
- Discord ([discord.md](discord.md)) and Twilio SMS/WhatsApp ([twilio.md](twilio.md)) are sibling
  channels on the same identity store.
