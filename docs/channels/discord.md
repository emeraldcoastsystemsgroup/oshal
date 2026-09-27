# Discord channel — message your swarm in a DM

Talk to your oshal assistant from a Discord direct message. A DM runs on the accountable Jarvis bot
under **your** identity, with your own model settings and cost tracking. Discord is only the surface.

## What runs where

```
Discord Gateway  ──MESSAGE_CREATE (DM only)──▶  discord-channel-adapter (in the api)
                                                    │  resolve (discord, your user id) → user_sub
                                                    ▼
                                                Jarvis bot  (BotNodeClient.execute → cost in chat_tasks)
                                                    │
Discord REST     ◀──POST /channels/{dm}/messages────┘  reply in the same DM
```

Discord delivers bot messages over its Gateway (a WebSocket), not an HTTP webhook, so there is no
public inbound URL to register. The api opens the Gateway connection itself when a token is
configured, identifies with only the **Direct Messages** and **Message Content** intents, and drops
everything that is not a human DM: server (guild) posts, group DMs and bot messages never reach a
swarm. When a Gateway event omits its channel type, the adapter asks the Discord API for it before
delivering anything.

## Operator setup (one time)

1. Create an application and a bot in the Discord Developer Portal **under the business email**
   `maintainer@emeraldcoastsystemsgroup.com` (the partner-app registration rule in
   [docs/partner-app-registration.md](../partner-app-registration.md)).
2. Under **Bot**, enable the **Message Content** privileged intent. Copy the bot token.
3. Set it on the controller and recreate the api (a restart does not pick up new compose env):
   ```
   DISCORD_BOT_TOKEN=<the bot token>
   ```
   `docker-compose.oshal-local.yml` forwards it to the api service only; no bot container carries it
   (guard: `tests/unit/compose-env-passthrough.spec.ts`).

With the token unset the Gateway is an explicit no-op, `GET /api/channels` reports
`discord.configured: false`, and `POST /api/channels/discord/link` answers `503 discord_not_configured`.

## How a user connects (self-serve)

1. Signed in, the user calls `POST /api/channels/discord/link` (auth-gated). It returns a one-time
   code valid for 15 minutes: `{ code, message: "DM the Discord bot: LINK <code>" }`.
2. The user sends `LINK <code>` to the bot in a DM. The code is redeemed only for the provider it was
   minted for, so a Telegram or SMS code cannot link a Discord account.
3. From then on the user DMs the bot and the swarm answers in that DM.

`DELETE /api/channels/discord/:discordUserId` unlinks one of the caller's own Discord accounts.

## Isolation, replay and refusals

- The `(discord, Discord user id) → user_sub` binding in `channel_links` is the boundary. The bot
  turn runs under `runWithRequestIdentity({ sub: owner, isOperator: false })`.
- Each Discord message id is claimed once in `channel_inbound_events` before any bot turn, so a
  Gateway reconnect that redelivers a message does not run it twice.
- A Discord account already bound to one oshal user is **not** moved by another user's code. The
  sender is told to unlink it from the owning account first.
- Every refusal — an unlinked sender, an invalid/expired/other-provider code, and a refused rebind —
  is written to the refusal ledger (`oshal_refusals`, codes `channel_link_required`,
  `channel_link_code_refused`, `channel_identity_rebind_denied`). The actor is a pseudonymous key
  (`channel:discord:<truncated SHA-256>`), never the raw Discord id, and the rows are visible to
  operators only.

Locally tested against a real PostgreSQL under forced row-level security and a local WebSocket
server speaking the Gateway protocol (`tests/unit/chat-channel-inbound-postgres.spec.ts`,
`tests/unit/chat-channel-denial-audit.spec.ts`). The AI Test Lab card
`channel-inbound-round-trip` runs the same flow on a deployment with the bot turn and the Discord
send doubled. No real Discord DM has been exchanged with a deployment yet.

## Limits

- **One shared deployment bot.** Every user who links talks to the same Discord bot.
- **DMs only, text only.** Attachments are ignored.
- **Context is per DM channel.** Follow-ups land in the same conversation task.
