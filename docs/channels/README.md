# Chat channels — connect a chat channel in 5 minutes

Ambient surfaces that let a user **message their swarm in an app they already have open** — the
inbound counterpart to the cockpit. A channel is a *surface over the accountable bot*, never a new
brain: an inbound message resolves to the oshal user who linked that chat and runs on the same Jarvis
bot the cockpit uses, so per-user data access and cost capture (`chat_tasks`, ADR-036/050) apply.

## The one page

Everything lives on one cockpit page: **Chat channels** — in the left rail under the platform tools,
and under **Settings → Chat channels**. It has two halves:

- **Deployment bot setup** (operators only): paste the Discord bot token → **Save & connect**. The
  token is checked with Discord, stored encrypted, and the bot connects immediately — no `.env`
  edit, no container recreate. The card shows Connected / Offline, the bot's name, an **Add the bot
  to your server** button, and names the two things that go wrong (token rejected, Message Content
  intent off).
- **Your channels** (every signed-in user): **Link my Discord / Telegram / SMS / WhatsApp** → a
  15-minute one-time code, the exact text to send, a **Copy** button, a one-click opener (the DM, the
  `t.me` deep link, WhatsApp or Messages with the text pre-filled) and a countdown. **Linked
  accounts** lists what is bound to you with an **Unlink** button.

## Five minutes, per channel

| Minute | Discord | Telegram | SMS / WhatsApp |
| --- | --- | --- | --- |
| 0–3 (operator, once) | Developer Portal → New Application → Bot → Reset Token → Message Content Intent ON → paste token on the card → Add the bot to your server. Full clicks: [discord.md](discord.md). | @BotFather → `/newbot` → token into `TELEGRAM_BOT_TOKEN` → `POST /api/channels/telegram/register-webhook`. [telegram.md](telegram.md) | Twilio number (SMS) or WhatsApp sender into `TWILIO_INBOUND_NUMBER` / `TWILIO_WHATSAPP_FROM`, webhook → `/api/sms/inbound`. [twilio.md](twilio.md) |
| 3–4 (you) | Chat channels → **Link my Discord** → **Open a DM with the bot** → paste `LINK <code>` into the **Message @bot** field. | Chat channels → **Link my Telegram** → **Open Telegram and connect** (sends `/start <code>` for you). | Chat channels → **Link my SMS / WhatsApp** → the opener pre-fills `LINK <code>` to the number shown. |
| 4–5 (you) | Reply `Connected.` → ask your first question in the same DM. | Reply `Connected.` → message the bot. | Reply `Connected.` → text or WhatsApp the number. |

What you still do by hand, and why: creating the Discord application and bot (Discord has no API
for that), switching the Message Content intent on (a Discord policy toggle), adding the bot to a
server you are in (Discord only lets you DM a bot you share a server with), and sending the one
`LINK <code>` message (that is the proof you own the chat identity). Everything else is a click on
the card.

## Status

| Channel | Status | Guide |
| --- | --- | --- |
| Discord | Built: DM-only Gateway listener, cockpit setup card (token validated live, encrypted at rest, Gateway started in process), link/unlink from the card; locally proven end to end. **Live DM receipt on the deployed box still outstanding** — the operator runs it with a fresh Discord account following the runbook. | [discord.md](discord.md) |
| Telegram | Built (single shared bot, `TELEGRAM_BOT_TOKEN` + webhook registration); link from the card; locally tested, no live DM receipt yet | [telegram.md](telegram.md) |
| Twilio (SMS / voice) | Outbound per-user operation built; inbound SMS → Jarvis built, link from the card; locally tested, not live-proven | [twilio.md](twilio.md) |
| WhatsApp-via-Twilio | Outbound notification transport built; inbound WhatsApp → Jarvis built, link from the card; locally tested, not live-proven | [twilio.md](twilio.md) |

Every inbound channel shares one identity store (`channel_links`, one row per provider identity),
claims each provider occurrence once before any bot turn (`channel_inbound_events`), and records every
refusal — unlinked sender, refused link code, refused cross-user rebind, legacy link without an
issuer — in the refusal ledger under a pseudonymous actor. The AI Test Lab cards
`channel-inbound-bindings`, `channel-inbound-round-trip` and `channel-operator-setup` exercise the
surface on a deployment; `npm run test:channels` runs the suites locally.

See [BACKLOG.md → Chat-channel surfaces](../BACKLOG.md) for what is still open (live receipts per
provider, Telegram/Twilio setup from the card, proactive push over linked channels).
