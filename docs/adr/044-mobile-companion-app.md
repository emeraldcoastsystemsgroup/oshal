# ADR-044 — Mobile companion app: OSHAL in your pocket, and the phone as a swarm target

- **Status:** Proposed (Phase 1 — installable PWA — ships with this ADR; Phases 2–4 are design)
- **Date:** 2026-06-17
- **Supersedes/extends:** [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  the A2A / remote-client surface ([src/shared/types/a2a.ts](../../src/shared/types/a2a.ts),
  [src/features/remote-client/](../../src/features/remote-client/)), and the per-user connector model
- **Related backlog:** "Mobile companion app — installable cockpit + phone-as-swarm-target"

## Context

The operator wants OSHAL on their phone: an installable app that authenticates against
their personal swarm, surfaces a "tell me everything" briefing, and — the novel part —
**registers the phone itself as a swarm node** so any bot can query the device (location,
battery, notifications, photos, health) like any other tool.

The reflexive move is to build a new native app and a new mobile API. That is wrong for the
same reason ADR-036 makes the controller-shortcut wrong: it would duplicate auth, bypass the
bot-owned domain + cost capture, and grow a second surface that drifts from the cockpit.

Three things make this tractable **without** a rewrite:

1. **The cockpit is already a responsive web app.** [src/pages/cockpit/index.html](../../src/pages/cockpit/index.html)
   ships a `viewport` meta, a `.mobile-menu-btn`, and config-driven branding. It renders on a
   phone today — it is simply not *installable* (no manifest, no service worker, no push).
2. **Auth already supports mobile.** [src/shared/middleware/oidc.ts](../../src/shared/middleware/oidc.ts)
   does standard OIDC auth-code flow against generic issuers (Google/Entra/Keycloak). Native
   mobile apps use the identical flow plus PKCE — no new auth system, one extra redirect URI.
3. **A device-as-agent surface already exists.** The A2A / remote-client contracts already
   model an external endpoint that registers an agent card, heartbeats, and exposes MCP tools
   ([a2a.ts](../../src/shared/types/a2a.ts)). The platform enum is `['macos','windows','linux','unknown']`.
   The phone is **one enum value (`ios`/`android`) and a thin HTTP-MCP client away** from being
   a first-class swarm node. This is the exact rail to reuse — not a new "device API".

## Decision

Ship the mobile companion as **the existing cockpit, wrapped — not rebuilt** — in four
independently-useful phases, reusing OSHAL's existing rails at each step.

### Phase 1 — Installable PWA (ships with this ADR)

Make `/cockpit/` installable: a `manifest.webmanifest`, a `service-worker.js` (offline app
shell + cached static assets), maskable icons, and the iOS/Android install meta tags wired
into the cockpit `<head>`. Result: "Add to Home Screen" gives a fullscreen, icon-on-springboard
app against the live swarm. No native toolchain, no store submission. This validates the
on-device UX immediately and is the foundation every later phase builds on.

### Phase 2 — Capacitor native shell

Wrap the **same** cockpit web app in a [Capacitor](https://capacitorjs.com) WebView to get a
real App Store / Play Store binary. One codebase; the web app and the app stay in lockstep.
This unlocks the native capabilities the PWA can't reach:

- **PKCE mobile OIDC client** (register the mobile redirect URI under the business email per
  [docs/partner-app-registration.md](../partner-app-registration.md)).
- **Biometric unlock**, **real push notifications**, **secure credential storage**.
- **Native plugins** (GPS, battery, contacts, mic, camera, health) — the raw material Phase 4
  exposes to the swarm.

### Phase 3 — Jarvis: the "tell me everything" briefing

A personal-assistant bot per [ADR-036](036-bot-owned-application-architecture.md): it owns its
domain, aggregates across the user's connectors (email, calendar, home, Signals), **stores a
`user_sub`-keyed brief**, and the mobile surface is a *view* over that store. A scheduled
`morning-brief` ticket-type fires it on the existing Redis scheduler (the same pattern the
smart-home app already uses); push delivers the result. Voice in/out is a **pluggable TTS/STT
harness** (per the CLAUDE.md rule that TTS must be pluggable, parallel to LLM providers) —
speech-to-text → existing `BotNodeClient.execute` chat path → TTS. Cost is auto-captured via
`recordCost` → `chat_tasks` because reasoning runs on the accountable bot, never in the app.

### Phase 4 — The phone as a swarm target

The app runs as a **remote A2A client**. It registers an agent card with `platform: 'ios'`/
`'android'`, heartbeats to the existing control-plane endpoints, and exposes device
capabilities as MCP tools (`device.location`, `device.battery`, `device.notify`,
`device.photo`, `device.health`). Any swarm bot then queries the phone exactly like any other
remote tool. Concretely:

- Add `'ios'` / `'android'` to `RemoteClientPlatformSchema` in [a2a.ts](../../src/shared/types/a2a.ts).
- Add an **HTTP-MCP client** in the Capacitor app — a sibling to the existing
  [mcp-stdio-client](../../src/features/remote-client/services/mcp-stdio-client.ts); the
  `A2ATransportSchema` already allows `http`/`sse`, so no contract change is needed there.
- The app heartbeats via the existing remote-client registry/heartbeat contracts.

Device tools are **user-consented per capability** and scoped to the owner's `user_sub` — a
phone is a personal device, so its tools are personal∪shared exactly like connector tokens
([ADR-042](042-iot-connector-tenancy.md)).

## Consequences

**Positive**
- **No rewrite, no second codebase.** Every phase wraps or extends what exists; the cockpit
  stays the single UI surface across web and mobile.
- **Reuses three existing rails** — OIDC auth, the bot-owned domain + cost capture, and the
  A2A remote-client surface — so net-new surface area is small (a manifest/SW, a Capacitor
  shell, one enum value, one HTTP-MCP client, one assistant bot).
- Phase 1 is shippable today and useful on its own; each later phase is independently valuable.

**Negative / costs**
- Phases 2–4 add a native toolchain (Capacitor), an app-store presence, and a mobile OIDC
  client registration — real but bounded.
- **The phone-as-target surface is a new ingress** into the swarm and needs a security review
  before production: device-tool consent, per-capability scoping, and the same auth-gating
  posture as every other route (the remote-client endpoints must be `requiresAuth`).
- Push + voice each pull in a vendor; both must stay behind pluggable harnesses (TTS rule),
  not hardcoded.

## Build order

1. **Phase 1 PWA** — manifest + service worker + icons + install meta (this ADR). **First.**
2. **Phase 2 Capacitor shell** — WebView wrap, PKCE mobile client, biometric unlock, push scaffold.
3. **Phase 3 Jarvis** — assistant bot (ADR-036 shape) + `morning-brief` scheduled ticket-type + voice harness.
4. **Phase 4 phone-as-target** — `ios`/`android` platform enum + device MCP tools + heartbeat,
   behind a security review.
