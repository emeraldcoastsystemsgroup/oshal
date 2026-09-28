# ADR-166: Calling is an optional, owner-authorized application

## Status

Accepted for Calling Assistant 0.1.1 — 2026-09-26. The optional package is installed with calling
**off**. The narrow platform callback contract is in [core PR #830](https://github.com/emeraldcoastsystemsgroup/oshal/pull/830),
whose preview is deployed but whose review and promotion remain open. Neither installation nor the
mock-carrier and audio tests establishes a real telephone handoff.

## Context

The requested outcome is an assistant that can navigate an authorized phone task, wait through an
automated menu, identify a human, and bridge the owner in. Existing Twilio notification transports,
the read-only connector, Jarvis's configuration-only screen, and `/api/voice-sim` do not provide that
outcome. A carrier connection alone must never make calling available to every bot or user.

The [Calling Assistant package](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/calling-assistant)
now contains a registered `calling_task` tool, `calling-operator` bot, Assisted Phone Task workflow,
configuration screen, durable reports and carrier adapter. Its v0.1.1 validation covers local
configuration/policy tests, database and fake-carrier integration, real WAV processing and a
simulated handoff. The carrier account, public callback route and actual phone legs are not proven.

## Decision

1. **Keep telephony in the optional application.** The platform supplies identity, encrypted
   connections, named authorization, package tools, voice services and workflow execution. It does
   not compile a Calling-specific dialer, IVR policy or provider credential into core. Jarvis and
   other authorized entry points use the package's registered tool rather than a separate call path.
2. **Use a narrow signed callback boundary.** The package verifies the provider's request; core
   resolves the persisted owner and issuer afresh and enforces current `calling.execute` authority
   and registration availability. A signed callback is not a blanket grant, and a model-supplied
   owner is not authority. Core PR #830 carries this shared contract; it is not yet a completed
   mainline release.
3. **Bind every task to the exact owner and selected connection.** The application `caller` role is
   explicitly assigned in Access; installation does not assign it. Personal or accessible shared
   Twilio connections must be selected by the owner. No deployment credential or another user's
   connection is an implicit fallback. Configuration, reports, tool calls and callbacks retain the
   owner's subject and issuer and recheck authorization at execution.
4. **Default off and bound actions.** Installation and a connected account do not enable calling.
   The owner chooses a voice-capable sender, handoff phone, exact destination allowlist, disclosure,
   listen window, duration/turn limits and estimated rates, then acknowledges account use. A call
   requires an explicit approved task. Estimated cents are a planning gate, **not** a carrier
   billing cap. Cancellation, revoked access or changed/disabled settings stop further actions.
5. **Keep evidence honest.** Runs and reports are durable and idempotent; an ambiguous carrier
   create response is marked uncertain rather than redialed. Interrupted audio work times out after
   restart rather than repeating an action. A report distinguishes carrier status, transcripts,
   decisions and audio hashes from a verified human handoff. The 45 real-audio cases and simulated
   bridge validate the local workflow, not Twilio transport, public reachability, billing or a
   two-leg live call. Completed recordings are deleted after processing; cleanup failures remain
   visible, while transcripts and metadata remain owner-scoped.

## Consequences and remaining acceptance

Calling remains disabled until the intended account receives `caller`, the operator deliberately
configures Twilio and a controlled destination, and the public signed callback path and real phone
handoff are verified. The current startup persistence warning must be identified and resolved or
explicitly dispositioned before readiness is called green. Core PR #830 still needs review and
promotion. These are tracked in the [package backlog](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/calling-assistant/BACKLOG.md)
and the [core backlog](../BACKLOG.md); none is closed by the synthetic suite.

Streaming/full-duplex conversation, arbitrary claim negotiation, additional carriers, unattended
service-principal enrollment and automated recording-retention policy are outside v0.1.1. Each
requires a separate policy and acceptance decision before being represented as shipped.
