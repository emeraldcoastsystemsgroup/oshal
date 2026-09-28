# Synthetic phone-call simulator

This is a test harness, not a telephone service. It makes **zero external calls** and uses only
fictional 555 numbers. It does not read the operator's real email, claims, contacts, Twilio account,
or recordings. Jarvis may invoke the simulation CLI to start a fixture and read an assessable report;
it must never describe the result as a live insurer call.

## What is wired

- Jarvis's versioned catalog advertises `scripts/oshal-voice-sim.js` for explicit *mock/simulate/test*
  requests. `start <scenario-id>` queues a background in-process scenario worker; `status` and
  `report` retrieve it. The CLI carries the exact user subject and service secret to the controller.
- `GET /api/voice-sim/scenarios`, `POST /api/voice-sim/runs`, and `GET /api/voice-sim/runs/:id`
  expose fixtures and full owner-scoped traces. `GET /api/voice-sim/mock-data/identity?runId=…`
  and `GET /api/voice-sim/mock-data/mail?runId=…` return fictional speaker/inbox responses.
  The worker records the lookup responses and derives a synthetic claim brief before it dials;
  speaker mismatch, no claim, or multiple claims stop before the fake call. `manual` runs accept
  `POST /api/voice-sim/runs/:id/relay` with one mock audio event at a time.
  `POST /api/voice-sim/runs/:id/callback` accepts fake carrier statuses; duplicate and
  out-of-order statuses are recorded but cannot rewind the run.
- Under `/api/voice-sim/mock-twilio/Accounts/ACSIMULATED`, the fake Calls API creates/reads a
  synthetic call, accepts a mock hangup, and the fake Conference API reads a successful handoff.
  Only `+12025550100` (caller), `+12025550101` (insurer) and `+12025550102` (owner) appear in
  the trace. The fake endpoint never delegates to Twilio's real API.
- Each run records ordered identity/mail mock responses, `claim.brief_ready`, `twilio.request`,
  `twilio.response`, `twilio.callback`, `relay.received`, `agent.interpreted`, `relay.send`, and
  `run.completed` events. A final assessment checks expected outcome, synthetic-only destinations,
  a claim brief before dial, handoff-after-human, and no DTMF from music. Reports are
  JSON files in `OSHAL_VOICE_SIM_ROOT/<sha256-owner-prefix>/<run-id>.json`; by default the API
  container uses its persistent `/app/output/oshal-voice-sim` volume, and local development uses
  the OS temp directory. The service stops at 20 simulated minutes or 64 input events.

The built-in scenarios cover speaker mismatch, missing/ambiguous claim, a normal claim menu,
reordered digits, spoken choices, hold music,
song lyrics that resemble menu commands, ambiguous/low-confidence recognition, voicemail,
owner not answering, remote disconnect, long hold timeout, and an untrusted instruction embedded
in an IVR prompt. `manual` allows more synthetic relay sequences without altering the preset suite.

## Exercise it

Run the deterministic tests with:

```text
npx vitest run --no-file-parallelism tests/unit/voice-call-sim.spec.ts tests/unit/jarvis-tool-catalog.spec.ts
```

From a controller-connected Jarvis tool shell:

```text
node /app/scripts/oshal-voice-sim.js scenarios
node /app/scripts/oshal-voice-sim.js start hold-music
node /app/scripts/oshal-voice-sim.js status <run-id>
node /app/scripts/oshal-voice-sim.js report <run-id>
```

For a manual run, start `manual`, use `dial <run-id>` to call the fake insurer, then
`feed <run-id> '{"kind":"speech","speaker":"ivr","confidence":0.98,"text":"For claims press 7."}'`.
The `feed` command also accepts `music`, `silence`, `human`, and `disconnect` events. A `human`
event must have `speaker:"human"` and adequate confidence before the synthetic owner/conference
legs are created. Browser POSTs require a same-origin JSON request and `X-Oshal-Voice-Sim: 1`;
the CLI uses owner-bound internal service authentication. Reports are private, uncached, and keyed
to the exact authenticated owner.

## What this does not prove

The music/speech label and confidence values are **mock input**. These tests prove how the call
controller reacts to those signals, not that a real STT/acoustic classifier can identify a song,
detect a human, or understand a changed insurer IVR. The background worker is in-process; a restart
marks an unfinished run interrupted instead of resuming it. Pricing in reports is illustrative,
not a Twilio invoice. Before any live dialer is enabled, add separate recorded-audio recognition
tests, authenticated Twilio webhook/WebSocket contract tests, a durable job queue, explicit owner
approval, a verified insurer number, cost limits, and a bounded live call to an owned test line.
