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
   Discord refuses custom-domain registration for this account, so the Discord application may be
   owned by the operator's personal Discord account instead. Nothing in oshal depends on which
   account owns the application; the api only needs the bot token.
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
   code valid for 15 minutes: `{ code, message: "DM the Discord bot: LINK <code>" }`. The code
   records the verified issuer of the signed-in session (for a browser session, the ID token's
   `iss`). A session that carries no verified issuer gets `403 issuer_required` and no code.
2. The user sends `LINK <code>` to the bot in a DM. The code is redeemed only for the provider it was
   minted for, so a Telegram or SMS code cannot link a Discord account.
3. From then on the user DMs the bot and the swarm answers in that DM.

`DELETE /api/channels/discord/:discordUserId` unlinks one of the caller's own Discord accounts.

## Isolation, replay and refusals

- The `(discord, Discord user id) → user_sub` binding in `channel_links` is the boundary. The link
  also stores the owner's verified issuer (`user_issuer`), copied from the code when it is redeemed.
  The bot turn runs under `runWithRequestIdentity({ sub: owner, principalIssuer: user_issuer,
  isOperator: false })`, so the delegation the controller signs for the bot node names both the
  owner and the issuer. User-bound delegation refuses a subject without an issuer.
- Each Discord message id is claimed once in `channel_inbound_events` before any bot turn, so a
  Gateway reconnect that redelivers a message does not run it twice.
- A Discord account already bound to one oshal user is **not** moved by another user's code. The
  sender is told to unlink it from the owning account first.
- Every refusal — an unlinked sender, an invalid/expired/other-provider code, and a refused rebind —
  is written to the refusal ledger (`oshal_refusals`, codes `channel_link_required`,
  `channel_link_code_refused`, `channel_identity_rebind_denied`). The actor is a pseudonymous key
  (`channel:discord:<truncated SHA-256>`), never the raw Discord id, and the rows are visible to
  operators only.

## Links made before the issuer was recorded (re-link)

A Discord account linked before links stored the owner's issuer has `user_issuer` NULL (migration
170 adds the column and leaves existing rows NULL). Such a link cannot reach the swarm: the DM is
refused before any bot turn, recorded in the refusal ledger (`channel_link_required`, reason
`link_issuer_missing`), and the sender is told to re-link. oshal never guesses an issuer for it.

To repair it, the owner opens the cockpit → Channels → Connect Discord, gets a fresh code and sends
`LINK <code>` in the same DM. The re-link by the same user writes the issuer onto the existing link,
and the next DM runs normally. A code minted before the upgrade has no issuer and is refused as
invalid, so the user must generate a new one.

Locally tested against a real PostgreSQL under forced row-level security and a local WebSocket
server speaking the Gateway protocol (`tests/unit/chat-channel-inbound-postgres.spec.ts`,
`tests/unit/chat-channel-denial-audit.spec.ts`). `tests/unit/chat-channel-principal-issuer.spec.ts`
drives a linked DM into the real controller delegation client and verifies the signed token names
the owner and the issuer. The AI Test Lab card
`channel-inbound-round-trip` runs the same flow on a deployment with the bot turn and the Discord
send doubled. No real Discord DM has been exchanged with a deployment yet.

## Limits

- **One shared deployment bot.** Every user who links talks to the same Discord bot.
- **DMs only, text only.** Attachments are ignored.
- **Context is per DM channel.** Follow-ups land in the same conversation task.
