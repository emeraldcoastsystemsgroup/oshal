# Twilio — phone + text for the Intelligent Communication swarm

Twilio supplies bounded phone/text operations on **the user's own Twilio account**. It is a chosen
paid pipe, never a platform-owned key or a mandatory default. Connecting an account does not grant
a model or unattended local CLI access to its credential.

Two distinct layers use it — don't conflate them:

| Layer | Credential | Purpose |
| --- | --- | --- |
| Operator notification transports (`twilio-sms` / `twilio-voice` / `twilio-whatsapp` in [src/features/notifications/](../../src/features/notifications/)) | `TWILIO_*` env vars in `.env` | `notifyOperator()` alerts (watchdog, job failures); WhatsApp uses the same Twilio Messages API with `whatsapp:` addresses |
| Per-user connector (this doc) | Pasted per-user secret, encrypted in `oshal_connections` | Authenticated, fixed server notification operations for that user |

## Connect (per user, ~2 minutes)

1. Get the **Account SID** and **Auth Token** from the [Twilio console](https://console.twilio.com/)
   (Account → API keys & tokens). The account needs at least one phone number for sends.
2. Open `/utilities` in the cockpit → **Twilio (SMS & Voice)** card → paste the Account SID in the
   first field and the Auth Token in the token field → Save. The card validates the pair against
   the Twilio Accounts API before storing (encrypted, `provider='twilio'`, stored as one
   `SID:AuthToken` secret — the Jira two-value shape).
3. Done. No partner OAuth app to register — Twilio auth is account-scoped HTTP Basic, so there is
   no `partner-app-registration.md` entry to follow.

## Bounded Twilio operations

Current per-user Twilio delivery is owned by the fixed in-process server operation in
[`twilio-sms-operation.ts`](../../src/app/routes/twilio-sms-operation.ts). Authenticated
notification test sends and scheduled morning briefs derive the exact user subject server-side;
the credential is decrypted inside that operation and used only for a sender-number lookup and
one SMS request. It never enters a child environment, argv, task workspace, or model-visible tool.

The former generic CLI is a fail-closed compatibility tombstone. General conversational or
ticket-driven Twilio reads, SMS, and calls are not enabled under the current security boundary.
Enabling one requires its own schema-bounded server handler with exact inputs, subject scoping,
confirmation for paid outward actions, bounded output, and audited credential containment.
Connector presence alone is never execution authority.

Legacy workspace files, raw connector environment variables, direct database decryption from a
model-invoked process, and generic HTTP credential carriers are prohibited. If the fixed operation
cannot resolve the authenticated user's connection, it fails closed as not connected.

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
