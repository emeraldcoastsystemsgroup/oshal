# ADR-047 — Smart-home aggregation: the OSHAL edge-agent (software body on the LAN, swarm brain in the cloud)

- **Status:** Proposed (design only — nothing built; this ADR is the gate before code)
- **Date:** 2026-06-17
- **Related:** [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-037 (communications swarm — the connector + `scripts/oshal-<provider>.js` reference)](037-communications-swarm.md),
  [ADR-042 (personal∪shared / household tenancy)](042-iot-connector-tenancy.md),
  [ADR-044 (mobile companion — the device-as-swarm-node A2A rail)](044-mobile-companion-app.md);
  the A2A / remote-client surface ([src/shared/types/a2a.ts](../../src/shared/types/a2a.ts),
  [src/features/remote-client/](../../src/features/remote-client/));
  the existing smart-home app (store-side `home.yaml`,
  [ai-lab/bot-personas/home-bot.yaml](../../ai-lab/bot-personas/home-bot.yaml),
  store-side `home.html`).
- **Related backlog:** "Smart-home aggregation — the OSHAL edge-agent model".

## Context

The operator has lived five years of smart-home **ecosystem fragmentation**: Alexa, Ring, Google
Home, SmartThings, Matter, even the Fiat — each wants to be *the* hub, so every device gets
re-entered per-provider, and a spouse linking Ring under *her* account breaks the whole house.
The goal is the obvious one nobody ships: **aggregate every ecosystem under one roof, with AI on
top, so you never touch the per-provider mess again.**

Two failure modes have to be named so we don't re-solve the wrong one:

- **Ecosystem fragmentation** — the walled gardens fight. *Solvable.*
- **Identity fragmentation** — accounts scattered across people/providers. No aggregator fixes the
  *accounts*; an aggregator only makes you link each one **once** and never per-device again.

The reflexive move — make Alexa and Google Home talk to each other — is wrong: those are
themselves walled-garden aggregators that actively conflict. **You must aggregate one layer down.**

A second hard truth: **aggregation has to physically happen somewhere that can reach the devices.**
Many integrations are LAN-local (Matter, Zigbee/Z-Wave radios) — a cloud server cannot reach a
Zigbee bulb in the kitchen. So the aggregator needs a *presence on the home network*. The operator's
correction, which this ADR adopts: **that presence is software, not a hardware appliance.** It runs
on a device they already own.

Three rails make this tractable without inventing anything:

1. **ADR-044 already made "a device is a swarm node."** A remote A2A client registers an agent card,
   heartbeats, and exposes device capabilities as MCP tools; the platform enum already includes
   `macos`/`windows`/`linux`. A laptop or mini-PC is therefore **already a valid swarm node** — no
   new "edge API" is needed, only a new *toolset* behind the same rail.
2. **ADR-036 already separates body from brain.** Data-access/actuation is cheap I/O; reasoning runs
   on the accountable bot with cost capture. The edge agent is the *body*; the cloud `home-bot` is
   the *brain*.
3. **Home Assistant Core already integrated everything** — ~2,000 integrations including Ring, Google,
   SmartThings, Matter, and Stellantis/Fiat. Its `GET /api/states` returns **every entity across every
   integration in one list** — that single endpoint *is* the aggregation; control is
   `POST /api/services/<domain>/<service>`. We do not reimplement 2,000 integrations.

## Decision

Aggregate at the **Home Assistant layer**, via a lightweight **OSHAL edge-agent** that is an
**A2A remote-client swarm node (ADR-044's rail) whose toolset is a co-located Home Assistant Core**,
with the cloud swarm as the reasoning brain. Concretely:

**1. Aggregate at the HA layer, never the voice-assistant layer.** Alexa/Google Home are walled
gardens; HA sits below them and already holds the long tail (Ring, the Fiat) nothing else does.

**2. The aggregator is a software edge bot-node, not an appliance.** It is the **existing A2A
remote-client** ([a2a.ts](../../src/shared/types/a2a.ts)) running on a device the user already owns —
**laptop first; a cheap always-on host (mini-PC / old PC / NAS / generic Android-TV box) later** for
24/7. It registers an agent card (`platform: linux|windows|macos` — already in the enum, *no contract
change*), heartbeats to the control plane, and exposes the home as MCP tools (`home.list`,
`home.control`, `home.state`). The cloud swarm reaches it exactly like any other remote tool.

**3. It embeds Home Assistant Core as its device engine.** "Embeds" = **co-located on the host**: HA
Core runs as a container/process on the same machine; the edge bot-node talks to it over its
**local** REST/WebSocket API and re-exposes the unified entity list + service calls as the MCP tools
above. HA Core does the integration grunt work and the LAN-local radio work; the edge agent is the
bridge up to the swarm. (For the pure IP/cloud subset — WiFi/Matter-over-IP/cloud accounts — the
agent *may* later talk natively, but HA Core is the coverage engine and the decision here.)

**4. The cloud `home-bot` is the brain (ADR-036).** "Turn off everything downstairs", "is the garage
locked", "make it cozy" → the home-bot reasons over the unified entity list and emits structured
intents the edge agent actuates. Reasoning runs on the accountable bot → cost auto-captured via
`recordCost` → `chat_tasks`. The edge agent never reasons; the brain never touches a Zigbee radio.

**5. Thin extension nodes point *at* the host — they do not host the engine.** Phone (ADR-044
companion: voice/presence/notify), smart speakers (voice in/out add-on), and **Fire TV Stick /
Android-TV** (display + voice + TV control — the "show the dashboard / change the input" surface).
These reuse ADR-044's `ios`/`android` platform additions and the HTTP-MCP client. **A Firestick is
too weak (~1–2 GB RAM, Fire OS kills background services) to host HA Core** — it is a surface, the
engine lives on the always-on host. TV control is **real but protocol-bounded**: Google Cast/DIAL,
HDMI-CEC, and vendor APIs (Roku ECP, LG webOS, Samsung Tizen) — push a display, change inputs,
control playback, launch apps; *not* paint arbitrary pixels on a cast-only TV.

**6. Identity fragmentation is solved structurally, not by an API.** **One household HA instance**
holds all integrations (Ring linked once *inside* it, under whatever account); OSHAL connects to that
single instance as a **shared-household** surface ([ADR-042](042-iot-connector-tenancy.md)
personal∪shared). The per-account chaos stays trapped inside HA; no re-linking per device, ever again.

**7. Aggregate-first, Matter-migrate later.** Get the bot controlling devices **as-is** through the
edge agent first; migrate devices to Matter opportunistically afterward to kill the root duplication.
Do **not** block the connector on any migration.

## Physics constraints (honest — these are the real limits, not policy)

- **Something must stay awake on the LAN for 24/7 behavior.** A laptop is a perfect host *while it's
  on and awake*; schedules, away-from-home control, and voice-while-out need an always-on host. This
  is a host-uptime fact, not a buy-a-special-device requirement → **laptop-first, cheap always-on host
  later.**
- **IP/WiFi/Matter/cloud devices = pure software, no dongle.** Only legacy **Zigbee/Z-Wave** need a
  ~$20 USB radio plugged into the host (because they aren't on WiFi at all). Most modern gear is
  moving to Matter/WiFi, so the dongle-free surface grows over time.

## Consequences

**Positive**
- **Reuses three rails** — the A2A remote-client surface (ADR-044), the bot-owned domain + cost
  capture (ADR-036), and HA Core's ~2,000 integrations — so net-new surface is small: one edge
  bot-node package, one MCP toolset, one household connection. No new "device API".
- One **unified entity list** ends per-provider re-entry; one **household HA** ends the identity mess.
- Brain stays central (reasoning, cost, multi-user); the body is disposable software on any owned
  device. The phone/Firestick extension story falls straight out of ADR-044.

**Negative / costs**
- **A new privileged ingress.** The edge agent has broad LAN reach and actuation power; like ADR-044's
  phone-as-target it needs a **security review before production** — registration auth, per-capability
  consent, owner-`user_sub` scoping, and the same `requiresAuth` posture as every route. Treat the
  edge↔swarm channel like the token broker.
- **Carries HA Core as a dependency** (the chosen tradeoff vs. an OSHAL-native IP/cloud aggregator):
  another moving piece to package, update, and back up on the host.
- **The always-on-host gap is real** — laptop-only means automations only run when the laptop is on,
  until the user adds a persistent host. Set that expectation; don't pretend a closed laptop fires
  schedules.

**Deferred**
- OSHAL-native aggregation for the IP/cloud subset (HA Core is v1; native is an optimization later).
- Voice/STT/TTS on the extension nodes → the **pluggable TTS/STT harness** (CLAUDE.md rule), shared
  with ADR-044 Phase 3, not a hardcoded vendor.
- Cross-household / multi-tenant sharing of an edge agent (privacy boundary — out of scope for v1).
- Alexa-exclusive devices → stays staged (no public third-party API; see the Alexa backlog entry).

## Build order (phased — laptop-first, embed HA Core, aggregate-first)

1. **Edge bot-node on the laptop, embedding HA Core.** Package = {OSHAL edge agent (A2A remote-client)
   + HA Core co-located}; the agent registers/heartbeats and exposes `home.list`/`home.control`/
   `home.state` MCP tools bridged from HA's local API. Prove: the `home-bot` lists + controls devices
   spanning **two original ecosystems** (e.g. a Ring entity + a SmartThings light) end-to-end from the
   cockpit, reusing the store-side `home.html` as the view. **First, behind a
   security review of the new ingress.**
2. **Always-on host** — same package on a cheap persistent device; schedules + away-from-home + voice
   become first-class (reuse the existing Redis scheduler + home-schedule branch already built).
3. **Extension nodes** — phone (ADR-044 companion), Firestick/Android-TV (display + TV control via
   Cast/CEC/vendor APIs), speakers (voice harness). They point at the host; none host the engine.
4. **Matter migration** — opportunistic, after the above; collapses per-provider duplication at the
   root. Never a blocker.
</content>
</invoke>
