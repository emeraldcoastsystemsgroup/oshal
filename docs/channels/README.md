# Chat channels

Ambient surfaces that let a user **message their swarm in an app they already have open** — the
inbound counterpart to the cockpit. A channel is a *surface over the accountable bot*, never a new
brain: an inbound message resolves to the OSHAL user who linked that chat and runs on the same Jarvis
bot the cockpit uses, so per-user data access and cost capture (`chat_tasks`, ADR-036/050) apply.

| Channel | Status | Guide |
| --- | --- | --- |
| Telegram | Built (single shared demo bot) | [telegram.md](telegram.md) |
| Discord | Backlog (interactions webhook / gateway) | — |
| Twilio (SMS / voice) | Built as an OUTBOUND bot capability (per-user BYO connector + comms-bot CLI); inbound webhook exists, but SMS→Jarvis channel routing still backlog | [twilio.md](twilio.md) |
| WhatsApp-via-Twilio | Built as an OUTBOUND notification transport; inbound WhatsApp chat channel still backlog | [twilio.md](twilio.md) |

See [BACKLOG.md → Chat-channel surfaces](../BACKLOG.md) for the roadmap, the provider asymmetry
(Telegram trivial, inbound WhatsApp chat still needs a staged provider path), and the skill-import
"absorb" plan.
