# Telegram channel — message your swarm

Talk to your Open Swarm assistant from a Telegram chat. An inbound message runs on the accountable
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

## How a user connects (self-serve)

1. Cockpit → **Channels → Connect Telegram** calls `POST /api/channels/telegram/link`, which mints a
   one-time code and a `https://t.me/<bot>?start=<code>` deep link (valid 15 minutes).
2. The user taps it; Telegram opens the bot and sends `/start <code>`.
3. The bot redeems the code, binding **(telegram, that chat) → the user's sub** permanently. From then
   on the user just messages the bot and the swarm answers.

`GET /api/channels` lists a user's linked channels + whether the bot is configured;
`DELETE /api/channels/telegram/:channelUserId` unlinks one (owner-scoped).

## Isolation

The `(provider, channel_user_id) → user_sub` binding is the boundary. A shared bot routes each DM to
the correct linked user; an unlinked chat only ever gets linking instructions — never another user's
data. Every link read/write is user_sub-scoped (`ChannelLinkService`).

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
- Discord (interactions/gateway) and Twilio SMS/voice/WhatsApp are on the backlog — see
  [BACKLOG.md → Chat-channel surfaces](../BACKLOG.md).
