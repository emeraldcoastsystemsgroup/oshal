# Drone relay — the expansion: postures, two planes, proxies, couriers, and formations beyond a line

**Status:** design, with the sized parts BUILT in store package `drone-relay` 0.2.0 (2026-09-14):
relay postures (hover / perch) with the antenna height a perch needs, an out-of-band control
channel sized by its reach and heartbeat air time, a courier sized by its trip, and the
store-and-forward numbers on every simulated run. The rest — ground nodes, the control plane
inside the simulation, lattices, two radios per relay — is the package's backlog B7–B10 with
done-when criteria. Companion to [ADR-155](../adr/155-drone-relay-chains.md) (the chain) and
[drone-relay-link-hardware](./drone-relay-link-hardware.md) (the radio module). Every number
below is one the package's tests pin (`tests/engine-chain.test.js`, `tests/engine-sim.test.js`)
on the modelled link; none is a measurement.

## 0. What the first cut showed, and what this answers

The 0.1.0 chain put two prices on the idea. **Battery:** hovering relays on an eight-minute
battery need about 15 relays in rotation to hold a 1 km chain of four slots — each slot burns a
whole flight per two minutes on station. **Bandwidth:** every frame crosses every hop of one
shared channel, so the tip gets 50 kbps of ESP-NOW's 250. Both are the price of the simplest
design, not of the idea. Sections 1 to 4 take each price apart; 5 and 6 generalise the formation
and say where computing lives in it.

## 1. Postures: hover, perch, ground node

A relay is a radio that has to be *somewhere*, not a drone that has to be *flying*. The chain's
rules do not care which; the battery does.

| Posture | What holds the slot | Time on station (far slot, default chain) | Relays in rotation (1 km, four slots) | What it costs |
|---|---|---|---|---|
| **hover** | the airframe, motors running | 123 s | about 15 | nothing new |
| **perch** | the airframe landed at the slot, motors off, radio + companion + flight controller awake at 3 % of hover draw | 4111 s (about 68 min) | about 5 | a perch with height, or the ground exponent |
| ground node (B7) | an ESP32 on a battery with a short mast, placed by hand or dropped — not a drone | days | none | it cannot move to close a gap |

**Perch is the lever.** The plan takes `posture: perch` and `perchDrawFraction` (default 0.03: a
flight controller, a Pi Zero 2 W and an ESP32 awake against a mini drone's hover draw); a perched
relay's time on station is the flight budget left at its slot divided by that fraction, and the
rotation shrinks to about one relay per slot plus one. The simulation agrees: six perched relays
hold the default chain for thirty minutes with no forced return and no swap, draining about 3 %
of the run's seconds; four hold it for two hours. A perched relay that must move — an elastic
target, a shift inward, the flight home — takes off and drains at the full rate; the on-board
rule is unchanged, only "hold" means "land here" instead of "hover here".

**The price is height.** A radio on the ground is not a radio in the air. Espressif's own
open-field test between two ESP32-C6 boards near the ground fits a path-loss exponent near 3
against the 2.2 the chain models air to air. The plan states, for a perch, the antenna height
that keeps 60 % of the first Fresnel zone clear at mid-hop (`0.3·√(λ·hop)`: **1.5 m** at a 200 m
hop on 2.4 GHz) and warns when the spec still assumes the air-to-air exponent. Planned honestly on
exponent 3 instead, ESP-NOW's design range at 10 dB falls from 344 m to **73 m**, the hop to 43 m,
and the same kilometre needs **22 relays** (25 in rotation) — 12 in long-range mode. So a perched
chain wants perches with height: rooftops, posts, trees, a stub mast on the landing gear. The
range test in the hardware document (§5) has a ground pass and a height pass for exactly this.

**What perch asks of the vehicle.** A landing on unprepared ground (legs, a level check, the
flight controller's disarm-on-land), a take-off again on the companion's command, and an antenna
that clears the airframe when it sits. The core's MAVLink provider already arms, takes off
(`MAV_CMD_NAV_TAKEOFF`), flies GUIDED setpoints, lands and returns — proven against ArduPilot SITL
(ADR-099) — so the companion's "hold" becoming "land here" adds no command to the core.

## 2. Two planes: the control plane out of band

In 0.1.0 heartbeats and commands ride the chain, so a broken chain is also a silent tip: the
controller sees a ghost until the staleness window, declares the gap, and the outer segment walks
inward blind on its own rule. A second radio on every drone — LoRa, usually — that reaches the
base direct changes what the controller knows, not what the chain does:

- **No ghosts.** A lost relay is known the moment its heartbeat stops; the gap is known at the
  heartbeat period, not after the staleness window.
- **The outer segment is commanded, not blind.** The meeting point can be sent to the relays
  beyond the gap; the inward walk becomes the backstop for a dead control radio.
- **The RTL word survives the chain.** The controller's return-to-launch reaches every drone
  whether or not the chain stands; the flight controller's own failsafes stay the last line.
- **The data plane is free for data.** Heartbeats leave the ESP-NOW channel to the tip's traffic.

The plan sizes it (`controlChannel`, any catalog radio but the chain's; `heartbeatS`): the
radio's direct reach at the design margin from the base, and the air the heartbeats cost. LoRa at
915 MHz reaches a kilometre with tens of dB to spare on the model, but a 50-byte frame at SF9 is
about 330 ms on the air, so five nodes heartbeating every 2 s (the core node's cadence) occupy
**82.5 %** of the channel — 19 % first-try delivery if nobody schedules them. Every 10 s it is
**16.5 %** (72 % unscheduled), and scheduled by the base — one slot per node per period, which
the base can do because it is the only clock everyone hears — it fits with room for commands. BLE
coded PHY as the control radio keeps 10 dB only to 204 m: it does not reach. The simulation still
runs the chain in band (B8 puts the control plane inside it); the cost is a second module on
every drone (the hardware document's parts list already carries the SX1262 row) and the band's
duty-cycle rules for the region.

## 3. Proxy: respond by proxy, receive commands by proxy

The operator's phrase from the first ask. The outermost reachable relay is the tip's **proxy**
while the tip is out of reach:

1. **Status by proxy.** A query for the tip is answered from the tip's last heartbeat, stamped
   with its age. The reply is an ordinary `reply` envelope from the relay, signed with the
   relay's own pair key; the controller knows it is a proxy answer because `src` is the relay,
   not the tip. One field is added to the envelope for this: `proxy: { for, ageS }`.
2. **Commands by proxy.** A command for the tip is queued at the relay (bounded, oldest first)
   and forwarded when the link returns. The relay cannot re-sign, so the original MAC and
   timestamp must still verify at the tip: the queue's hold time is bounded by the tip's replay
   window, and a command older than that is dropped naming the reason, like every other drop.
3. **Store and forward at the tip.** The tip keeps collecting through an outage and drains its
   buffer through the chain's spare capacity once reconnected. Every run now reports this: the
   tight chain's 7.5 s outage costs a 20 kbps tip about **19 KB**, drained in 1.4 s by the
   105 kbps the two-hop chain has spare; a tip that uses every kbps never drains, which is the
   plan's way of saying to leave headroom (tip rate × expected outage ÷ acceptable drain time).

Rules 1 and 2 are protocol semantics for the relay role on the drone node (package B11, on B1's
relay role); rule 3's numbers are engine code. None of it needs the relay to read a payload.

## 4. Couriers: the data the chain cannot carry

Pictures and scans do not fit a 50 kbps chain, and the chain should not try: it carries commands,
telemetry and events. Bulk data goes home on a **courier** — a drone that flies to the tip, lands
beside it, loads over a fast radio and flies home. The plan sizes it (`courierMB`,
`courierTransport`): load time at the courier radio's planning rate, trip time (out, load, home,
turnaround), MB per hour and the rate the trips amount to.

| Courier radio | 100 MB per trip | Load | Trip | Rate | Fits one battery |
|---|---|---|---|---|---|
| ESP-NOW (the chain's own) | 1 km out and back | 53 min | — | 212 kbps if it could | no, not on 8 min |
| Wi-Fi Direct (the catalog's "last hop" radio) on a 15-minute battery | 1 km out and back | 40 s | 613 s | **587 MB/h ≈ 1.3 Mbps** | yes |

Twenty-six times the chain, from one drone in rotation and a Wi-Fi radio the tip's Pi already
has. The relays rotating home in a hovering chain are *not* free couriers — they come from their
own slots, a hop or more short of the tip and outside a Wi-Fi hop of it — so the courier is a
dedicated trip, and it needs storage at the tip and a landing beside it (the perch requirements of
§1 again).

## 5. Formations beyond a line

The chain is one instance of a rule: **targets are a function of the structure and of who is
connected right now.** The 0.1.0 line evaluates that function on a corridor every tick, which is
why losing a relay needs no second planner (ADR-155 D1). The same function on other structures:

- **A tree (B5).** One trunk of relays, two or more branches to two or more tips. The envelope
  already routes it (source routes are paths in any graph); the planner does not yet size it. The
  trunk's hops carry every branch's traffic, so the tip's rate becomes
  `throughput / (trunkHops + branchHops)` per branch with the trunk carrying the sum — the tree's
  price is on the trunk. A trunk loss reconnects both branches through the meet-in-the-middle
  rule; a branch loss is a chain loss.
- **A lattice (B9).** Slots on a grid over an area, so the tip roams and always has a neighbour
  within a hop. The elastic rule becomes an assignment — connected relays to the slots that keep
  every occupied cell reachable, inner slots first — the same idea with a matching instead of a
  spread.
- **Two bases.** Two chains from two ground stations meeting in the middle; the tip's route
  switches to whichever base's chain is nearer. On source routing that is a change in the
  controller's route table, not in any relay; not planned, listed so it is not re-invented.
- **Two radios per relay (B10).** One module facing in, one facing out, on different channels,
  removes the every-frame-crosses-every-hop division on paper; whether it does in the air depends
  on how far the interference reaches, which the bench must measure before the catalog says so.

## 6. Where computing lives in the chain

The first ask said "drone-to-drone computing". Honestly placed:

| Where | What computes there | Why |
|---|---|---|
| the tip (a Pi Zero 2 W on the recon drone) | detection, compression, the survey itself — send events and thumbnails through the chain, keep the frames for the courier | it is the only node with the data and a CPU |
| the base | the swarm's agents: the relay-designer sizing the chain, the drone package flying the formation, whatever reads the data | that is where the swarm is |
| every relay | forwarding by route, the on-board rule, the proxy queue, store-and-forward, appending what it hears (RSSI today; a sensor reading tomorrow) | an ESP32-C6 has no CPU for inference; a Pi relay has a little, and the chain must not depend on it |

A2A stays the external-agent boundary; drone-to-drone traffic is the swarm's own envelope,
carried hop by hop (ADR-155 D3). The one "distributed computation" the chain does for free is
being a **linear sensor array**: every heartbeat forwarded inward already carries each relay's
signal reading, and the same `via` stamp can carry anything a relay measures at its slot.

## 7. What each expansion asks of the vehicle and the companion

| Expansion | Vehicle | Companion | Core |
|---|---|---|---|
| perch | legs, level landing, disarm-on-land, an antenna that clears the airframe sitting | "hold" = land; take-off on command | none — the MAVLink provider already takes off and lands |
| control plane | a LoRa module per drone | a second `LinkTransport` (B2); heartbeats scheduled by the base | none |
| proxy | nothing | the queue and the proxy reply in the relay role (B1) | none |
| courier | storage at the tip; a Wi-Fi radio on the tip and the courier | a transfer over Wi-Fi Direct when landed | none |
| tree / lattice | nothing | nothing | none (planner work in the package) |

## 8. What stays open

The operator's decisions are ADR-155's Q1–Q6 (Q5 perch or hover first; Q6 a LoRa control radio in
the first chain). The package BACKLOG carries B7 (ground nodes), B8 (the control plane in the
simulation), B9 (a lattice), B10 (two radios per relay), B11 (proxy replies and the command queue)
beside B1–B6, each with done-when criteria. Nothing in this document has flown; the range test in the hardware document is still
the first thing to do.

## 9. How to continue this work

Everything below is as of 2026-09-14, the day the thread that built 0.1.0 and 0.2.0 closed. Nothing
has flown; the package is not installed on the box.

### Where it lives

| What | Where | Branch |
|---|---|---|
| The package: engine (`src-routes/engine/*.ts` → compiled `routes/engine/*.js`), routes, tile, persona, manifest, tests, Test Lab catalog | `drone-relay/` in the store repo | `feat/package-test-catalog-pilots` (store PR #185) |
| The package's contract (what the engine computes, exactly) and its backlog B1–B11 | `drone-relay/docs/ARCHITECTURE.md`, `drone-relay/BACKLOG.md` | same |
| The decisions (D1–D11), the open questions (Q1–Q6), what the simulation proved | [ADR-155](../adr/155-drone-relay-chains.md) | `feat/store-compatibility-gate` (core PR #431) |
| The radio module, what not to fork in ArduPilot, the range test, R1–R5 bring-up | [drone-relay-link-hardware](./drone-relay-link-hardware.md) | same |
| This document; the core backlog pointer | here; `docs/BACKLOG.md` § *Drone relay chains* | same |

Both branches are the single active development branch of their repo: join them, do not mint
another (CLAUDE.md Rule 0).

### Build and test the package

From a store checkout with a core checkout beside it (the core's `node_modules` present):

```bash
# compile src-routes → routes with the framework's own compiler (whole store; --check-only verifies)
node scripts/security/rebuild-store-routes.mjs --store <store> --framework <core>
# the plain-node suites store-ci runs (34 cases; no install)
cd drone-relay && node --test "tests/*-*.test.js"
# the framework-coupled route suite (11 cases over loopback HTTP, the catalog through core's loader)
OSHAL_CORE_DIR=<core> node --test tests/routes.core.test.js
```

Before pushing: bump `version` in `oshal-app.yaml`, the `drone-relay` row of `marketplace.json`
(same description, same version) and `audits/drone-relay.json`, regenerate `README.md`
(`node scripts/gen-readme-apps-table.mjs`), then run `check-catalog`, `check-store-test-discovery`,
`check-store-security`, `check-store-separation`, `validate-package-audits`,
`check-no-public-secret-fallback` and the SEC-06 suites under `scripts/security/`. The package's
`package-smoke.ts` / `.js` must stay byte-identical to the canonical pair. Every number in the
tests, the Test Lab catalog's `expected` lines (each ≤ 500 characters or the whole manifest is
refused) and ADR-155's *Consequences* is pinned to the catalog rows: change a row and re-pin all
three in the same commit.

### Put it on the box

Install `drone-relay` like any store package (the cockpit's app store, or the package files under
the installed-apps path followed by one api restart — announce it in `COLLABORATE.md` first and
only on a quiet box). Then `/cockpit/?app=drone-relay`: size a chain, break it, read the write-up,
or ask the **relay-designer** in the right rail. The concierge reads the catalog through its tools
and never quotes a range from memory.

### The order that leads to a real chain

1. **The range test** (hardware document §5): two ESP32-C6 boards, a ground pass and a height
   pass. Replace the `esp-now` and `esp-now-lr` catalog rows with the measured sensitivity and
   state the exponent in each row's `source`; re-pin the tests. Until this is done every range is
   a model. This also decides Q5 (perch or hover first): if a stub mast on the landing gear gives
   the height pass's exponent, perch is cheap.
2. **The operator's decisions** — ADR-155 Q1–Q6 (first radios, where the relay role lives, the
   link model, trees, posture, a control radio). Each row has a recommendation.
3. **B1 — the relay role on the drone node** (a core PR, off unless configured): the envelope
   endpoint beside `/api/drone-node/command`, forwarding from the route alone, heartbeats inward
   with a `via` stamp; with **B11** the proxy reply and the command queue. Proven over loopback
   node doubles before any radio.
4. **B2 — the ESP-NOW `LinkTransport`** on the bench between boards, fragments and RSSI probe.
5. **R3** — ArduPilot SITL behind a relay node; kill the relay; watch the tip shift inward and
   return on its own rule while the controller logs the gap and the reconnection.
6. **R4 / R5** — relays on poles or carried; then three drones inside direct-link range as a fleet
   mission behind the confirm, so every failure has a fallback.

In the package meanwhile, in the order they pay: **B3** frame loss below the edge (makes staleness
and the detect windows meaningful), **B8** the control plane inside the simulation, **B7** ground
nodes, **B5 / B9** trees and lattices, **B10** two radios per relay (bench first), **B4** corridors
from the drone package's map, **B6** the formation handed to Drone Ops as a draft. Each has
done-when criteria in the package `BACKLOG.md`; none is started.

### What to trust

The engine is deterministic and every number the write-up or the concierge quotes is one a test
pins. Trust the *comparisons* (two designs on the same model) and the *arithmetic* (rotation,
air time, trips, buffers); do not trust a range, an outage second or a margin until the range test
has replaced the rows and R3–R5 have been flown. The rotation cycle keeps the reserve in it on
purpose — the simulation still forces returns with 13 and 14 hovering relays where the formula
says 15.
