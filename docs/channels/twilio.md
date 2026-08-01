# Twilio — phone + text for the Intelligent Communication swarm

Twilio gives the **communications-bot** its phone/text leg: read recent SMS/calls, send an SMS,
or place a spoken call — on **the user's own Twilio account** (BYO, per the BACKLOG ownership
caveat: Twilio is a *chosen* paid pipe, never a platform-owned key or a mandatory default).

Two distinct layers use it — don't conflate them:

| Layer | Credential | Purpose |
| --- | --- | --- |
| Operator notification transports (`twilio-sms` / `twilio-voice` / `twilio-whatsapp` in [src/features/notifications/](../../src/features/notifications/)) | `TWILIO_*` env vars in `.env` | `notifyOperator()` alerts (watchdog, job failures); WhatsApp uses the same Twilio Messages API with `whatsapp:` addresses |
| Per-user connector (this doc) | Pasted per-user secret, encrypted in `oshal_connections` | The communications-bot acting **for a user** in chat/tickets |

## Connect (per user, ~2 minutes)

1. Get the **Account SID** and **Auth Token** from the [Twilio console](https://console.twilio.com/)
   (Account → API keys & tokens). The account needs at least one phone number for sends.
2. Open `/utilities` in the cockpit → **Twilio (SMS & Voice)** card → paste the Account SID in the
   first field and the Auth Token in the token field → Save. The card validates the pair against
   the Twilio Accounts API before storing (encrypted, `provider='twilio'`, stored as one
   `SID:AuthToken` secret — the Jira two-value shape).
3. Done. No partner OAuth app to register — Twilio auth is account-scoped HTTP Basic, so there is
   no `partner-app-registration.md` entry to follow.

## What the bot can do

The communications-bot (persona [email-summarizer.yaml](../../ai-lab/bot-personas/email-summarizer.yaml))
shells out to [scripts/oshal-twilio.js](../../scripts/oshal-twilio.js) in its sandbox:

- **Reads** — `digest` (default), `messages --limit N`, `calls --limit N`, `numbers`, `account`.
- **Sends** (confirm-gated: `--confirm` / `OSHAL_MESSAGE_SEND_CONFIRM=true`, real money + a real
  phone ringing) — `sms <+E164> <text>`, `call <+E164> <spoken text>` (inline TwiML `<Say>`,
  XML-escaped). The "from" number is `TWILIO_FROM_NUMBER` if set, else the account's first number.

Credential resolution mirrors `oshal-smartthings.js`: controller-brokered secret
(`.oshal-cred-twilio` / `OSHAL_CRED_TWILIO`, via `resolveBotCreds` — scoped in
[manifest-worker-connector-scope.ts](../../src/app/manifest-worker-connector-scope.ts)) → per-user
DB decrypt → operator env pair (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`). Exit 2 = not connected.
Multi-account selection via `OSHAL_CONNECTION_LABEL` / `_EMAIL` / `_ID`; `accounts` lists them.

The declarative catalog spec ([swarm-apps/connectors/twilio.yaml](../../swarm-apps/connectors/twilio.yaml))
consumes the same broker secret as HTTP Basic for `/api/connectors/twilio` GET resources.

## US carrier reality (learned live, 2026-08-01)

- **Voice works immediately.** The first live proof on this platform was a call: trial account,
  API-provisioned number, verified destination — phone rang, TwiML spoke. Voice has no A2P gate.
- **SMS to US numbers is carrier-gated by A2P 10DLC.** An unregistered local number returns
  `undelivered` with **error 30034** regardless of code correctness — Twilio accepts the message
  and the carrier drops it. The fix is a paid account + A2P brand/campaign registration in the
  Twilio console. On this platform that registration is deliberately DEFERRED to the ECSG
  account migration (BACKLOG "HUMAN: migrate platform SaaS accounts to real ECSG accounts") —
  when SMS shows 30034, do not debug the stack and do not register A2P on the demo trial.
- **Trial accounts** can only reach verified numbers (`OutgoingCallerIds`) and prepend a
  "sent from a Twilio trial account" notice to every message.

## Still not built

Outbound WhatsApp-via-Twilio is built as the `twilio-whatsapp` notification transport. Still open:
inbound SMS → Jarvis (a true chat *channel* like Telegram — the signed Twilio webhook exists today
but only dispatches to an injected/default sink), inbound WhatsApp chat routing, and the
millionaire-alarm policy that chooses/fans out transports. See
[BACKLOG.md → Twilio as a pluggable notification transport](../BACKLOG.md).
