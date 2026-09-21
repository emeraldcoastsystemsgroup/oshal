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

## Inbound SMS → your swarm (built; not yet live-proven on this box)

A text to the deployment's Twilio number reaches the accountable Jarvis bot of the OSHAL user who
owns that number, and nobody else. The binding is the same `channel_links` identity store Telegram
uses, with `provider = 'sms'` and the sender's E.164 number as the identity:

1. In the cockpit, `POST /api/channels/sms/link` mints a one-time code (15 minutes) and returns the
   number to text it to.
2. The user texts `LINK <code>` to that number. The signed webhook
   (`POST /api/sms/inbound`) redeems it and the binding is written as that user.
3. From then on, a text from that number runs on the user's Jarvis under
   `runWithRequestIdentity({ sub, isOperator: false })`, and the answer returns over the user's OWN
   connected Twilio account through the fixed `sendUserTwilioSms` operation.

An **unlinked** number is refused: it gets linking guidance in the TwiML reply and reaches no swarm.
A number is normalized on both sides of the binding, so a separated form is the same identity. A
forged or unsigned POST is rejected at the signature before any of this runs.

Posture: **locally tested**, against a real Postgres with the real signed webhook
(`tests/unit/sms-inbound-dispatch.spec.ts`). It has NOT been exercised against live Twilio on this
deployment — that is the BACKLOG item "Communications bot live wrap-up", and US SMS is still behind
the A2P gate described above.

## Severity policy and the email fallback

`notifyBySeverity` routes `error` and `critical` over `twilio-whatsapp` ahead of `twilio-sms`,
because WhatsApp is not behind the A2P carrier gate. Every leg is intersected with the transports
that are actually configured, so a deployment without WhatsApp is unaffected.

On the per-user side, `NotificationRouter` falls back to email when the user's chosen channel cannot
be **attempted** — no sender registered, or no credential/destination for that user, which is exactly
what "Twilio absent" looks like. It deliberately does NOT fall back for an explicit mute, for quiet
hours, for email itself, or for a channel that was attempted and failed (a provider that reports a
failure may still have queued the message).

## Still not built

Inbound **WhatsApp** chat routing: the inbound webhook accepts only E.164 senders, so a
`whatsapp:+1…` sender is refused rather than guessed into an SMS identity. See
[BACKLOG.md → Twilio as a pluggable notification transport](../BACKLOG.md).
