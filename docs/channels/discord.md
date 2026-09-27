# Discord — message your swarm in a DM, from zero

This is the step-by-step runbook. It assumes **nothing**: no Discord account, no application, no
server. Follow it top to bottom and you end with a Discord DM that answers from your own oshal
assistant. Every step says what the screen shows so you know you are in the right place.

Two roles appear below. The **operator** sets up the deployment's one bot (Part A, once per
deployment). Every **user** links their own Discord account to their own oshal account (Part B,
once per person). If you run your own box you are both.

What you get: a DM to the bot runs on the accountable Jarvis bot under **your** identity, with your
own model settings and cost tracking. Discord is only the surface. The bot answers DMs only — never
server channels, never group DMs, never other bots.

```
Discord Gateway  ──MESSAGE_CREATE (DM only)──▶  discord-channel-adapter (in the api)
                                                    │  resolve (discord, your user id) → user_sub
                                                    ▼
                                                Jarvis bot  (BotNodeClient.execute → cost in chat_tasks)
                                                    │
Discord REST     ◀──POST /channels/{dm}/messages────┘  reply in the same DM
```

Discord delivers bot messages over its Gateway (a WebSocket the api opens outbound), not an HTTP
webhook, so there is **no public URL to register** and nothing to open in a firewall.

---

## Part A — operator: create the bot and connect it (about 10 minutes)

### A1. A Discord account for the application

Discord refuses registration from some custom-domain mailboxes, so the application is created on a
**personal Discord account made with a public-provider mailbox**. That is fine: nothing in oshal
depends on which account owns the application — the api only ever needs the bot token. Keep this
account's sign-in somewhere you will find it again; you need it to reset the token later.

1. Open `https://discord.com/register` in a browser.
   *Screen:* "Create an account" — Email, Display Name, Username, Password, Date of Birth.
2. Fill it in and click **Continue**. Complete the CAPTCHA if shown.
3. Discord sends a verification mail. Open it and click **Verify Email**.
   *Screen:* "Email Verified" — you land in the Discord web app. If Discord asks for a phone number,
   verify one; the Developer Portal requires a verified account.

### A2. Create the application and its bot

4. Open `https://discord.com/developers/applications` (signed in as that account).
   *Screen:* "Applications" list (empty on a fresh account) with a blue **New Application** button
   top-right.
5. Click **New Application**. *Dialog:* "Create an application" — Name, a Terms checkbox.
   Name it what you want the bot to be called (for example `oshal`), tick the terms box, click
   **Create**.
   *Screen:* "General Information" for the new app — the App Icon, Name, Description, and the
   **Application ID** (a long number). You do not need to copy anything here; the cockpit card reads
   the id from the token.
6. In the left sidebar click **Bot**.
   *Screen:* the bot's Username and Avatar at the top, then a **Token** block, then "Authorization
   Flow", then **Privileged Gateway Intents**.
7. In the **Token** block click **Reset Token**. *Dialog:* "Are you sure?" — click **Yes, do it!**
   If the account has two-factor authentication on, Discord asks for a 2FA code here.
   *Screen:* the token now shows once, with a **Copy** button. Click **Copy**. This is the one secret
   in the whole setup; it looks like three dot-separated groups of letters and digits. If you lose
   it, come back and Reset again (the old one stops working the moment you reset).
8. Scroll down to **Privileged Gateway Intents**. Switch **Message Content Intent** to ON (the
   toggle turns blue). Presence and Server Members can stay OFF.
   *Screen:* a green **Save Changes** bar appears at the bottom. Click it. Without this intent the
   bot connects but every DM arrives empty and the api log shows a Gateway close with code 4014.
9. Under **Authorization Flow** leave **Public Bot** ON (it must be ON for the invite link in A4 to
   work) and **Requires OAuth2 Code Grant** OFF.

### A3. Put the token into oshal

**The cockpit card (no file edit, no restart):**

10. Sign in to the cockpit as an operator and open **Chat channels** — it is in the left rail under
    the platform tools (bell = Notifications, speech bubbles = Chat channels), and also under
    **Settings → Chat channels**.
    *Screen:* a "Deployment bot setup — operator" section at the top with a **Discord bot** card
    showing the pill "not configured" and a **Bot token** field. If you do not see that section you
    are not an operator on this swarm (see Troubleshooting).
11. Paste the token into **Bot token** and click **Save & connect**.
    *What happens:* the api checks the token with Discord (`/users/@me` and
    `/oauth2/applications/@me`), stores it encrypted, and opens the Gateway. Within a few seconds
    the pill reads **Connected**, the line under it names the bot (`Bot: @<name>`, `Message Content
    intent: ON`), an **Add the bot to your server** button appears, and the token field is blank
    again (the token is never shown again).
    *If the pill reads "token rejected":* the token was wrong or has been reset since — Reset Token
    again and paste the new one.
    *If the pill reads "intent off":* step 8 was missed — switch the intent on, Save Changes, then
    Save & connect again.

**The fallback (`.env` + api recreate), for a box that does not have the card yet:**

- Put `DISCORD_BOT_TOKEN=<the token>` in the box's `.env`, then recreate the api container so it
  picks up the new environment (a plain restart does not):
  `docker compose -f docker-compose.oshal-local.yml up -d --no-deps oshal-api`. The compose file
  forwards the variable to the api only (guard: `tests/unit/compose-env-passthrough.spec.ts`).
- The env value is a **seed**: the card shows it as "token from DISCORD_BOT_TOKEN in .env (seed)".
  Saving a token from the card supersedes it, and **Disconnect** on the card turns the bot off even
  if the variable is still set. To undo the fallback later, remove the line and recreate once more.

### A4. Add the bot to a server you control

A person can only DM a bot they **share a server with**. So the bot needs to be in at least one
server that the users are in too. For a single-person box, make your own:

12. In the Discord app (web or desktop), signed in as the account you will link from, click the
    **+** ("Add a Server") at the bottom of the server rail on the left.
    *Dialog:* "Create Your Server" — click **Create My Own** → **For me and my friends** → give it
    a name → **Create**. *Screen:* the new server opens on its `#general` channel.
13. Back in the cockpit card, click **Add the bot to your server**. It opens
    `https://discord.com/oauth2/authorize?client_id=<application id>&permissions=2048&scope=bot`.
    *Screen:* "An external application wants to access your Discord account" with the bot's name and
    an **Add to server** dropdown. Pick the server from step 12, click **Continue**.
    *Screen:* the permission list ("Send Messages"). Click **Authorize**, pass the CAPTCHA.
    *Screen:* "Authorized — You may now close this window".
14. Look at the server's member list (the people icon top-right toggles it). The bot is listed.
    *Green dot* = the api's Gateway connection is up. *Grey / offline* = it is not (Troubleshooting).

Without the card you can build the same link in the portal: **OAuth2 → OAuth2 URL Generator →**
tick the `bot` scope → under Bot Permissions tick **Send Messages** → copy the Generated URL at the
bottom. The newer **Installation** page produces an equivalent "Install Link".

Part A is done. Every user on the deployment now links themselves in Part B.

---

## Part B — user: link your Discord account (about 2 minutes)

15. Sign in to the cockpit and open **Chat channels** (left rail, or Settings → Chat channels).
    *Screen:* under "Your channels", a **Discord** card with the pill **available** and the line
    `Bot: @<name> (online)`. If the pill says "not set up", Part A has not been done on this
    deployment.
16. Click **Link my Discord**.
    *Screen:* a code panel appears: "Send exactly this to Discord:" followed by a line like
    `LINK 3f9a1c07`, a **Copy** button, an **Open a DM with the bot** button, numbered steps and a
    countdown ("Code expires in 14:59"). The code is one-time and works for 15 minutes.
17. Click **Copy**, then **Open a DM with the bot**. It opens `https://discord.com/users/<bot id>`.
    *Screen:* the bot's profile popout. At the bottom is a text field **"Message @<bot>"** — that is
    the DM. (If there is no message field, you do not share a server with the bot yet: do A4 first.)
    You can reach the same DM from any server you share: click the bot's name in the member list →
    the popout → the "Message @<bot>" field. **Do not post the code in `#general`** — a server
    channel never reaches the bot and nothing answers there.
18. Paste `LINK <code>` into the message field and press Enter.
    *Reply:* `Connected. You can now message your swarm from this DM.`
    Other replies mean something specific — see Troubleshooting.
19. Ask something: `what can you do?` — the answer comes back in the same DM within a few seconds,
    and the cockpit card's **Linked accounts** list now shows `Discord: <your name> · <your id>`
    with an **Unlink** button.

Follow-up questions land in the same conversation (the task id is stable per DM). To move the link
to another Discord account, **Unlink** first, then link again from the other account.

---

## Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| Bot is **grey / offline** in the member list | The api has no Gateway connection: no token saved, the api is not running, or Discord refused the token. | Cockpit → Chat channels: the operator card's pill tells you which. "not configured" → do A3. "token rejected" → Reset Token, paste again. "Offline (connecting)" for more than a minute → `docker logs oshal-local-api 2>&1 \| grep -i discord`. |
| Card pill **intent off** / api log `Discord refused the Gateway intents` (close code 4014) | Message Content Intent is OFF in the portal, so Discord refuses the connection. | Bot → Privileged Gateway Intents → Message Content Intent ON → Save Changes → Save & connect again. |
| **Save & connect** answers "Token invalid" | Discord rejected the token: a typo, a partial paste, a user token instead of a bot token, or the token was reset since. | Bot → Reset Token → Copy → paste the whole thing (no spaces). |
| **Save & connect** answers "Discord could not be reached" | The api could not reach `discord.com`. | Check the box's outbound network / proxy; try again. |
| No "Message @bot" field on the bot's profile | You do not share a server with the bot. | Do A4 (create a server, Add the bot to your server), then reopen the DM. |
| You typed the code in `#general` and nothing happened | The bot only reads DMs by design; server channels are ignored. | Open the DM (step 17) and send it there. |
| Reply: `That link code is invalid or expired.` | The code is older than 15 minutes, was already used, was minted for another channel (Telegram/SMS codes do not work here), or the text was not exactly `LINK <code>`. | Click **Link my Discord** again and send the new `LINK <code>` line exactly (case does not matter). |
| Reply: `This DM is not linked to an oshal account yet.` | You never sent a code from this Discord account, or you sent it from a different Discord account than the one you are typing from now. | Link from this account (steps 16–18). |
| Reply: `This DM was connected before oshal recorded which sign-in it belongs to... Re-link it` | Your link predates the issuer fix (#841): the row has no verified sign-in issuer and can never run a bot turn. | **Link my Discord** again and send the new code in the same DM — the re-link repairs the row. |
| Reply: `This Discord account is already connected to a different oshal account.` | Someone else's oshal account owns this Discord identity. | That account opens Chat channels → Linked accounts → **Unlink**; then link from yours. |
| Reply: `Something went wrong reaching your swarm.` | The bot turn itself failed after the link resolved. | `docker logs oshal-local-api 2>&1 \| grep -A3 "Discord DM dispatch failed"` — the error under it names the cause. `User-bound delegation requires a verified principal issuer` → the api predates #841; update it. A brain/provider error → the Jarvis bot has no working model on this box (Settings → Global). |
| **Link my Discord** answers "Your sign-in did not carry a verified issuer" | Your cockpit session has no verified `iss` (the code would be unusable). | Sign out, sign back in, click **Link my Discord** again. |
| The cockpit page has no "Deployment bot setup" section | You are signed in, but not as an operator of this swarm. | Have the swarm root grant you admin on the **Users** page (ADR-148), or add your subject to `OSHAL_OPERATOR_SUBS` in `.env` as break-glass. |
| Bot online, DM sent, no reply and no log line | The DM was not delivered as a DM (Discord omitted `channel_type` and the lookup failed) or the message is empty text (an attachment, a sticker). | Send plain text. Check the log for `Discord channel verification failed`. |

Everything the bot refuses (an unlinked sender, a bad code, a cross-account rebind, a legacy link)
is written to the refusal ledger (`oshal_refusals`, operator-only) under a pseudonymous actor, so an
operator can see refusals without seeing anyone's Discord id.

---

## Reference

### Routes

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/channels/admin/discord` | operator | Configured / connected state, bot name and id, invite URL, DM URL, intent flag, last Gateway problem. Never the token. |
| `POST /api/channels/admin/discord` `{ token }` | operator | Validates the token live, stores it encrypted (`channel_provider_settings`, migration 171), starts the Gateway in-process, answers the state above. `400 token_required` / `token_malformed`, `422 token_invalid`, `502 discord_unreachable`. |
| `DELETE /api/channels/admin/discord` | operator | Stops the Gateway, forgets the token, keeps the provider disabled across boots. |
| `GET /api/channels` | any signed-in user | Per-channel wired state (`discord.configured`, `connected`, `problem`, `bot`, `dmUrl`) plus the caller's own links. |
| `POST /api/channels/discord/link` | any signed-in user | A 15-minute one-time code: `{ code, send: "LINK <code>", dmUrl, botUsername, botUserId }`. `503 discord_not_configured`, `403 issuer_required`. |
| `DELETE /api/channels/discord/:discordUserId` | owner | Unlinks one of the caller's own Discord accounts. |

Boot precedence for the token: a saved settings row (enabled → its decrypted token; disabled →
nothing, even with the env variable set), otherwise `DISCORD_BOT_TOKEN` as a seed. Replies are sent
with the token the running Gateway identified with, so what is connected and what answers are always
the same credential.

### Isolation, replay and refusals

- The `(discord, Discord user id) → user_sub` binding in `channel_links` is the boundary, and the
  link stores the owner's verified issuer (`user_issuer`). The bot turn runs under
  `runWithRequestIdentity({ sub: owner, principalIssuer: user_issuer, isOperator: false })`, so the
  delegation the controller signs for the bot node names both the owner and the issuer.
- Each Discord message id is claimed once in `channel_inbound_events` before any bot turn, so a
  Gateway reconnect that redelivers a message does not run it twice.
- The token is encrypted at rest with the connector-token cipher and is absent from every response
  and from the api log (guarded by `tests/unit/chat-channel-admin-postgres.spec.ts`).

### Evidence and posture

Locally tested against a real PostgreSQL under forced row-level security, a local HTTP server
speaking Discord's two identity reads, and a local WebSocket server speaking the Gateway protocol
(`tests/unit/chat-channel-admin-postgres.spec.ts`, `tests/unit/chat-channel-discord-identity.spec.ts`,
`tests/unit/chat-channel-inbound-postgres.spec.ts`, `tests/unit/chat-channel-denial-audit.spec.ts`,
`tests/unit/chat-channel-principal-issuer.spec.ts`); the cockpit card runs in headless Chromium
(`tests/unit/chat-channel-setup-card-browser.spec.ts`). The AI Test Lab cards
`channel-operator-setup` and `channel-inbound-round-trip` run on a deployment. **No real Discord DM
has been exchanged with a deployment yet** — that receipt is the operator's, following this page
with a fresh account (ROADMAP: "Discord DM channel — live proof").

### Limits

- **One shared deployment bot.** Every user who links talks to the same Discord bot.
- **DMs only, text only.** Server channels, group DMs, attachments and stickers are ignored.
- **Context is per DM channel.** Follow-ups land in the same conversation task.
- **Bots must share a server** with a person before that person can DM them (a Discord rule).
