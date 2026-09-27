# Chat channels

Ambient surfaces that let a user **message their swarm in an app they already have open** — the
inbound counterpart to the cockpit. A channel is a *surface over the accountable bot*, never a new
brain: an inbound message resolves to the OSHAL user who linked that chat and runs on the same Jarvis
bot the cockpit uses, so per-user data access and cost capture (`chat_tasks`, ADR-036/050) apply.

| Channel | Status | Guide |
| --- | --- | --- |
| Telegram | Built (single shared demo bot); locally tested, no live DM receipt yet | [telegram.md](telegram.md) |
| Discord | Built (DM-only Gateway listener, single shared bot); locally tested, needs `DISCORD_BOT_TOKEN` and a live DM receipt | [discord.md](discord.md) |
| Twilio (SMS / voice) | Outbound per-user operation built; inbound SMS → Jarvis built and locally tested, not live-proven | [twilio.md](twilio.md) |
| WhatsApp-via-Twilio | Outbound notification transport built; inbound WhatsApp → Jarvis built and locally tested, not live-proven | [twilio.md](twilio.md) |

Every inbound channel shares one identity store (`channel_links`, one row per provider identity),
claims each provider occurrence once before any bot turn (`channel_inbound_events`), and records every
refusal — unlinked sender, refused link code, refused cross-user rebind — in the refusal ledger under
a pseudonymous actor. The AI Test Lab card `channel-inbound-round-trip` exercises all four providers
on a deployment with the bot turn and the provider send doubled.

See [BACKLOG.md → Chat-channel surfaces](../BACKLOG.md) for what is still open (live receipts per
provider, provider enable/BYO configuration, proactive push over linked channels).
