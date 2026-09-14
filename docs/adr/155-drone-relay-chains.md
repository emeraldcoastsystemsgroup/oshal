# ADR-155 — Drone relay chains: a dynamic formation that carries commands and telemetry drone to drone

**Status:** Proposed, 2026-09-14. The formation rules, the simulation, the envelope protocol, the
transport catalog and the designer concierge are BUILT as store package `drone-relay` 0.1.0 the
same day (see *As built*); the relay role on the real drone node and a radio transport are its
backlog B1 and B2. Extends [ADR-099](./099-drones-as-remote-swarm-nodes.md) (each drone is a
swarm node; drone-to-drone coordination rides the swarm's authenticated rails) and
[ADR-098](./098-drone-ops-app.md) (draft → human approve → execute); companion of
[ADR-151](./151-eyes-and-hands-embodied-swarm.md) / [ADR-152](./152-embodied-physics-and-training-lab.md)
(the recon drone we print). Hardware and firmware posture:
[drone-relay-link-hardware](../architecture/drone-relay-link-hardware.md).

## Context

The operator's ask, 2026-09-13, in its own words in spirit: *mini drones may not carry much and
may only have certain kinds of communication. One dynamic formation I want is a drone-to-drone
network where a drone can fly outside its control area by communicating with another drone in its
communication area and respond by proxy, or receive commands by proxy. If there is a gap in the
chain, the chain must move up and fill that gap, and a new drone must be put in the gap. There are
drone configurations for predefined flight — how do we code up a dynamic configuration? How do we
design drone-to-drone computing over Bluetooth, Wi-Fi, Wi-Fi Direct, and so on, over A2A in a
distributed swarm? We will need drone modules for this, which probably means an OS mod on an
existing controller. We are working on the algorithm, how they will communicate, how we write
these up, and an agent that can help design these things in the controller.*

What exists (verify with the linked files before re-flagging):

- **A drone is a swarm node** (ADR-099): a companion process embeds a `DroneProvider` (sim or
  MAVLink), heartbeats into the controller every 2 s under the swarm service secret, and executes
  `{command, args}` envelopes at `POST /api/drone-node/command` (`src/app/drone-node-server.ts`).
  The controller's `DroneFleet` marks a node offline after 15 s of silence (`HEARTBEAT_STALE_MS`);
  the node's own link-loss failsafe returns to launch after `DRONE_LINK_FAILSAFE_S` (default 20 s)
  airborne without an ack. Fleet missions are validated against the geofence at execution time and
  separate drones by ≥ 10 m vertically or ≥ 20 m horizontally (`fleet-mission.ts`).
- **Fleet formations are predefined**: `fleet-patterns.ts` choreography and `FleetShowRunner`
  cue timelines put N drones at N points at N times on one human approval. No drone relays for
  another; every node talks to the controller directly, and "a multi-node mission self-realigns"
  is still an open done-when in [BACKLOG](../BACKLOG.md).
- **The drone we print** ([recon drone design](../architecture/embodied-recon-drone-hardware.md)):
  an ArduPilot H7 flight controller, a Raspberry Pi Zero 2 W running the drone node, an ELRS
  receiver as the pilot's kill switch — and no drone-to-drone radio. The Pi reaches the swarm over
  the drone-node rail on its own Wi-Fi, so the drone's reach is the base's Wi-Fi's.
- **The security property the operator chose the swarm for** (ADR-099 decision 2): no raw drone
  links exposed; every command and heartbeat authenticated and audited. A relay chain must keep
  that, not trade it for reach.

What a relay chain is, physically: a base station, a work point beyond the base radio's reach,
and relays spaced so that every hop keeps a link margin. The hop is a **link-budget** number —
transmit power, antenna gain, receiver sensitivity, a fade allowance, and how fast the signal
falls with distance between two small airframes. On the package's catalog and an air-to-air
exponent of 2.2, ESP-NOW keeps 10 dB of margin to about 340 m and Espressif's long-range mode to
about 800 m with a 2 dBi dipole each side; BLE coded PHY to about 200 m; LoRa at 915 MHz to tens of
kilometres with a few bytes per second; Wi-Fi Direct and Wi-Fi mesh, at the IEEE minimum
sensitivities, to about 80 m with megabits. Espressif's own open-field test between ESP32-C6 dev
boards near the ground is shorter — ESP-NOW close to 100 % delivery to 150 m and about 60 % at
300 m; long-range mode close to 100 % to 450 m — which fits an exponent nearer 3. Those numbers
size a chain; a range test at the relay band's height replaces them before a flight.

## Decision

### D1 — A chain is a formation over a corridor, not a flight plan; "dynamic" is one function evaluated every tick

A chain is specified by a **corridor** (a polyline from the base to the work point), a
**transport**, a **design margin**, a **spacing factor** and a **fleet**. The plan derives the
hop (`spacingFactor × designRange`), the number of relays (`ceil(L / hop) − 1`), the spares, and
the slots — evenly spaced along the corridor, each lifted to its role's altitude band.

The predefined formation is the plan at full strength. The dynamic formation is the **same
function of the corridor and of how many relays are connected right now**: `k` connected relays
are always spread evenly between the base and the tip's allowed reach (the *elastic rule*), and
the tip's allowed reach is `(k + 1) × allowedHop`. Nothing is re-planned when a relay is lost; the
targets simply re-evaluate with `k − 1`, and again with `k` when a spare arrives. That is what
makes the configuration dynamic without a second planner.

### D2 — Two brains, one rule each; every autonomous motion is inward

**On board every relay**, applied without the controller and shared line for line with a
companion firmware:

1. Battery: when flight time left ≤ the flight home along the corridor + a reserve → fly home.
2. Inner link (toward the base) silent past a detect window → **shift one hop inward** along
   the corridor and hold.
3. Inner link silent past an RTL window → fly home along the corridor.
4. The outer link is never chased: a relay never moves outward on its own.

Why inward only: a relay walking inward walks *into* coverage — its inner neighbour's, then the
next, then the base's — and along a corridor the whole chain flew, so the move is safe blind.
Walking outward blind is never safe. This is the operator's "the chain moves up to fill the gap":
the drone beyond the gap walks into it; the ones beyond that follow when their own inner link
stretches past the edge; the segment closes on the gap without anyone commanding it.

**At the controller**, over whatever is reachable:

1. A silent node stays on the roster until stale (its last position), then counts as lost — the
   controller acts on the same heartbeat truth a real controller has.
2. Elastic spacing (D1). When the tip is out of reach, the connected prefix stretches to the
   **midpoint** between its outermost node and the innermost lost node's last position, while the
   outer segment shifts in on its own — they **meet in the middle**.
3. A **gap policy**: `retreat` (the tip's reach is `(k+1) × designHop` — every hop keeps the
   design margin, and the tip comes back until a spare is in the chain) or `hold-degraded` (the
   tip holds while every hop stays above a lower margin).
4. **A spare joins at the inner end.** Fewer connected relays than the plan needs → a spare
   launches from the base and becomes the innermost relay; the elastic targets then shift the
   whole chain outward one slot as it arrives. The newcomer's flight is the shortest possible,
   it is inside the chain's coverage the whole way, and every link stays at the hop length while
   the chain slides out — link-safe by construction. This is the operator's "a new drone is put
   in the gap": the gap is filled from the base end, not by flying a fresh drone to the far slot.
5. **Swap before leaving.** A relay whose remaining flight time is approaching the flight home +
   reserve + the time a spare needs to join gets a spare launched *for it*; when the spare holds
   its slot, the tired relay is released home.
6. **No commanded move breaks a link that is good now** — a guard against both neighbours.

The plan also states what the battery demands of the fleet: **`sustainFleet`**, the relays needed
to hold every slot through battery rotations — each slot consumes one drone cycle (a flight plus
the ground turnaround) per stretch of time on station, summed over the slots. Below it, relays
leave on battery before a spare can take over.

### D3 — Envelopes over any radio: source-routed, authenticated end to end, forwarded from the route alone

A relayed command or heartbeat is the core drone node's payload wrapped in a **relay envelope**:

```
{ v: 1, id, kind: command | reply | heartbeat, src, dst, route: [src … dst], hop, ttl, ts, payload, via?, mac? }
```

- The controller builds the route from the chain order it knows; a reply is the reverse route.
- A relay decides **from the route alone**: forward to `route[hop + 1]`, deliver when it is the
  destination, or drop naming the reason (wrong node at this hop, a loop, an exhausted hop
  budget, an off-route index, a route that ends elsewhere). It never reads the payload.
- The source signs `[v, id, kind, src, dst, route, ts, payload]` (HMAC-SHA256, truncated) with
  the **pair key the destination holds from enrolment**; hop, ttl and the `via` stamps are the
  only fields a relay may change. A relay cannot forge a command or a heartbeat.
- A replay window refuses stale timestamps and repeated ids. Radios whose frame is smaller than
  a command (ESP-NOW v1 250 B, BLE 244 B, LoRa 222 B) carry fragments reassembled by sequence.
- Every relay forwarding a heartbeat inward appends **the signal it saw**, so the controller
  learns every hop's health from the traffic it already receives.

Over the swarm rail this is one addition to ADR-099's node: a relay-capable drone node exposes a
relay endpoint beside `/api/drone-node/command`; the controller hands an envelope to the innermost
reachable node (or the base's radio bridge) instead of dialling the tip's unreachable address, and
the tip's heartbeats arrive the same way. ADR-099's property holds: no raw drone link is exposed,
every envelope is authenticated, every command is logged at the node that executes it. **A2A**
stays what it is — the external-agent boundary; drone-to-drone traffic is the swarm's own
envelope, carried hop by hop.

### D4 — The transport is a pluggable link, not a protocol change

A `LinkTransport` (send, receive, probe → RSSI / loss / latency) per radio behind the same
envelope. The catalog carries seven with their honest properties, each row stating its source:
**ESP-NOW** (connectionless, any-to-any, at most 20 paired peers of which 17 encrypted, 250-byte v1
frames and 1470-byte v2 — the relaying is the application, i.e. D3), **ESP-NOW long-range mode**
(about 4 dB more sensitive than 802.11b, 256/512 kbps, ESP32-only), **Wi-Fi Direct** (one group
owner per group: a relay would need a concurrent client + owner role — fine for a video last hop,
wrong for the chain), **Wi-Fi mesh** (native multi-hop on ESP-WIFI-MESH or 802.11s; a node that
loses its parent re-selects one, and the on-board rule covers that window), **BLE coded PHY** (a
relay is central to its outer neighbour and peripheral to its inner one; latency adds per hop),
**LoRa 915** (kilometre hops, commands and heartbeats only; a 50-byte SF9 frame is about 330 ms
on the air), **Wi-Fi HaLow** (sub-GHz with throughput, several times the cost). The first
transport is ESP-NOW on an ESP32-C6 — the reasons are in the hardware document.

### D5 — No flight-stack fork: the "OS mod" is a companion firmware profile

ArduPilot / PX4 are not modified. The flight controller keeps MAVLink, the geofence and its own
failsafes. The **companion** runs the relay role: the TypeScript drone node on a Pi (B1) for
drones that carry one, or a small ESP-IDF firmware on the ESP32 module alone for drones that
cannot — both carrying the same three pure rules (the envelope forwarder, the on-board rule,
fragments) that the package implements and tests. The companion sends MAVLink heartbeats **as the
flight controller's ground station** while it is healthy, so ArduPilot's GCS failsafe
(`FS_GCS_ENABLE` → RTL, `FS_GCS_TIMEOUT` default 5 s) means exactly one thing: *the companion
stopped*. The chain's own link logic acts through ordinary GUIDED setpoints and an RTL mode switch
— the two things the core's `MavlinkDroneProvider` already does, with MAVLink 2 signing, proven
against ArduPilot SITL.

### D6 — Designed and rehearsed in a store package; the core is touched once, later, for the relay role

`drone-relay` (ai-engineering) bundles a deterministic engine (the budget, the planner, the two
rules, the envelope, a tick simulation, a generated write-up), an inline **relay-designer**
concierge on ten route-backed tools, and a tile. Same spec and scenario, same bytes. The one
core change this design needs — the relay role on `drone-node-server.ts`, off unless configured —
is the package's backlog B1 and arrives as its own core PR, proven against the package's node
doubles before it touches a vehicle.

### D7 — The safety doctrine is unchanged

A chain flies only as a fleet mission behind the human confirm (ADR-098/099). The on-board rule's
two autonomous motions — shift inward along the flown corridor, return to launch along it — are
shelter-ward, the class ADR-099 already exempts from confirm. The tip's own mission commands still
pass the geofence at execution. Nothing in the package commands a vehicle.

## Open decisions for the operator (cost / benefit)

| # | Question | Option A | Option B | Recommendation |
|---|---|---|---|---|
| Q1 | Radios in the first chain | ESP32-C6 relays on ESP-NOW (long-range mode for long hops); the base is an ESP32 bridge on the ground station; the tip may still carry a Pi | Linux companions everywhere on Wi-Fi mesh (heavier, more power, native multi-hop) | **A** — a small board on a port the flight controller already has; the package's rules are the mesh |
| Q2 | Where the relay role lives first | The TypeScript drone node (Pi), testable against the simulation and the node doubles | ESP-IDF firmware (C) on the module alone | **A first (B1), then B** — the rules are pure and identical in both |
| Q3 | The link model | A hard edge at the modelled zero-margin range (today) | Frame loss as a function of margin, its width from the range test (package B3) | **Run the range test first**, then B |
| Q4 | Two tips on one chain (a tree) | Later (package B5) | Now | **A** — the envelope already routes trees; the planner does not need to yet |

## Consequences

**What the simulation already puts numbers on** (`drone-relay` 0.1.0, `tests/engine-chain.test.js`
and `tests/engine-sim.test.js`, all deterministic, on the modelled link):

- A 1 km straight corridor on ESP-NOW at spacing 0.6 and 10 dB: four relays at 200 m, 15 dB of
  margin at the hop, 50 kbps and 100 ms end to end, two spares from a fleet of six.
- Losing the second relay at 60 s (batteries that outlast the run): the tip is never out of reach
  — the 400 m hop is still inside the modelled edge; the spare launches 6 s after the lost relay's
  last heartbeat; under `retreat` the tip heads back toward 800 m and turns round at 865 m once
  the spare is half a hop out, and the chain is restored 40 s after the launch; under
  `hold-degraded` the tip never moves, the worst hop margin is 8.6 dB, and the chain is restored
  34 s after the launch. With no spare in the fleet the tip retreats to 800 m and stays — the run
  ends *degraded*, which is the honest verdict.
- A tight chain (2 dB, spacing 0.9, one relay at 500 m): losing it puts the tip out of reach; the
  tip shifts inward on its own after the 4 s detect window; the controller declares the gap at
  6 s; the chain reconnects 7.5 s after the failure and is restored 90 s after it, once the spare
  has flown out.
- Endurance is a fleet-size question. On the recon drone's 8-minute battery the farthest relay
  holds its slot 123 s and the default chain needs about **15 relays in rotation**; with 6, a
  30-minute run forces 14 battery returns (the tip stays reachable on hops stretched to 6.4 dB),
  and with 15 it forces none. A 15-minute battery needs 8. That is the number the concierge puts
  in front of a designer before anything is bought: battery, corridor length, or relays.

**Backlog** (package `BACKLOG.md`, done-when criteria): B1 the relay role on the real drone node
(core PR), B2 the ESP-NOW transport adapter and the bench range test, B3 frame loss below the
edge, B4 corridors from the drone package's map with per-leg exponents, B5 trees, B6 the
formation handed to Drone Ops as a draft fleet mission.

**What this ADR does not claim:** a real-world range for any radio; that the hard-edge
simulation predicts an outage to the second in the air; that any vehicle has flown a chain.

## Build order

1. `drone-relay` 0.1.0 — done 2026-09-14 (engine, simulation, protocol, concierge, tile, tests).
2. The range test on two ESP32-C6 boards (hardware document §5) → the catalog rows become measured.
3. B1 — the relay role on the drone node, a core PR, proven over loopback node doubles.
4. B2 — the ESP-NOW adapter on the bench between boards.
5. ArduPilot SITL behind a relay node (hardware document R3).
6. A three-drone chain inside direct-link range, as a fleet mission, behind the confirm.

## As built — 2026-09-14, `drone-relay` 0.1.0

Store package `drone-relay` (ai-engineering): `engine/transports` (seven transports with their
sources, the budget, the closed-form range), `engine/path`, `engine/chain` (spec validation naming
the field, the plan with `onStationS` and `sustainFleet`, elastic targets, the tip's reach under
both policies, the guard), `engine/node-policy`, `engine/envelope` (routes, HMAC, forwarding
decisions, replay window, fragments), `engine/relay-sim` (roster / targets / dispatch / motion /
accounting, frames, metrics, verdict), `engine/design-doc`; routes for plans, preview, simulate,
the write-up and the envelope trace; the `relay-designer` concierge; the tile. Tests: 25 engine +
3 surface cases in store-ci (plain node), 11 framework-coupled route cases over loopback HTTP
including the catalog loaded through core's own loader; all registered in its Test Lab catalog.
The canonical route rebuild is byte-identical to the committed routes. No core code changed.
