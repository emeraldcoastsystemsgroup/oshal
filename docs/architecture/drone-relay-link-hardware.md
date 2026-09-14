# Drone relay — the link module, and what not to fork in the flight stack

**Status:** design; nothing here is built in hardware. Companion to
[ADR-155](../adr/155-drone-relay-chains.md) (relay chains) and the store package `drone-relay`,
whose engine implements the rules this hardware carries. Written 2026-09-14.

The question this answers: *mini drones may not carry much and may only have certain kinds of
communication; to relay drone to drone we probably need a module and an OS mod on an existing
controller.* The answer is a small radio module on the flight controller's spare serial port and a
**companion firmware profile**. The flight stack is not modified.

## 1. What a relay drone has to do

| Job | Where it runs | Where it is specified |
|---|---|---|
| Forward envelopes by their route, never read the payload | companion | `drone-relay` `engine/envelope` (`decideForward`, `advance`, `viaAppend`, fragments) |
| Shift one hop inward when the inner link goes quiet, fly home after the RTL window, fly home on battery | companion, commanding the flight controller | `engine/node-policy` (`decideLocal`) |
| Report its own state (pose, battery, signal it hears) inward | companion | the drone node's heartbeat body, carried as a `heartbeat` envelope |
| Fly, hold, geofence, RTL, land, the pilot's kill switch | **flight controller, unmodified** | ArduPilot / PX4 |

The three companion rules are pure functions with no I/O, tested in the package (`tests/engine-envelope`,
`tests/engine-node-policy`). A companion in TypeScript runs them as they are; a companion in C
ports them line for line and runs the same test vectors.

## 2. The module: an ESP32-C6 as the drone-to-drone radio

**Why this chip.** One ESP32-C6 carries ESP-NOW, Espressif's long-range Wi-Fi mode, Bluetooth LE 5
(including the coded PHY) and 802.15.4 on one small module, so the transport choice in ADR-155 D4
stays a firmware setting rather than a hardware change. ESP-NOW is connectionless and any-to-any,
which is what a chain needs: a relay talks to its inner and outer neighbour without an access
point. The facts that constrain the design, from Espressif's own documents:

- A node pairs at most **20 peers**, of which at most **17 encrypted** (7 by default). A chain node
  needs two neighbours plus spares in range; the limit is not a constraint for a line.
- An ESP-NOW v1 frame carries **250 bytes**; a v2 frame **1470 bytes**. A relay envelope with a
  `gotoPoint` payload is a few hundred bytes of JSON, so on v1 it rides as two or three of the
  package's fragments; where every node speaks v2 it fits one frame.
- Long-range mode runs at 256 or 512 kbps with about 4 dB more sensitivity than 802.11b. It is
  Espressif-only (every ESP32 except the C2), so in an LR chain the base is an ESP32 too.
- Espressif's open-field test between two ESP32-C6 dev boards with PCB antennas near the ground:
  ESP-NOW delivered close to 100 % to 150 m and about 60 % at 300 m (average latency under
  20 ms); long-range mode close to 100 % to 450 m and about 40 % at 900 m (under 25 ms). That is
  the ground-level baseline; the relays fly above the clutter, which the range test in §5 measures
  instead of assuming.

**Two fits, one radio.**

| Fit | Companion | How the radio attaches | Who runs the relay rules |
|---|---|---|---|
| **Relay-only** (the smallest drone: no Pi) | the ESP32-C6 itself | on the flight controller's TELEM2 UART (MAVLink 2) | an ESP-IDF firmware on the module: envelope forwarder, on-board rule, a MAVLink client for position, battery, GUIDED setpoints and RTL |
| **Tip / sensor drone** (the recon drone with its Pi Zero 2 W) | the drone node (`npm run drone:node`) on the Pi | the ESP32-C6 on the Pi's USB serial, as a frame bridge (serial ↔ ESP-NOW) | the drone node's relay role (package BACKLOG B1) |

The relay-only fit is the "module" the operator asked for: a thumbnail-sized board, under a watt
averaged against the recon drone's roughly 105 W hover (the
[recon drone design](embodied-recon-drone-hardware.md)), wired to four pins of a port the flight
controller already has.

**Antenna.** Use a module with a U.FL connector (the `-1U` variants) and a 2 dBi dipole, mounted
vertical, away from carbon plates, the ESCs and the battery leads; every node the same way so the
polarisations match. The catalog's long-range row assumes that dipole on both ends; the plain
ESP-NOW row assumes the PCB antenna.

**The base.** The same board on the ground station's USB, bridged into the controller the way the
tip's Pi bridges it: the controller's `RemoteDroneProvider` hands an envelope to the base bridge
instead of dialling an unreachable tip.

## 3. What not to fork: the flight stack

ArduPilot (or PX4) stays stock. Forking it would put a network feature inside the attitude-control
firmware, lose clean upgrades, and let a relay bug reach the motors. The "OS mod" is a companion
firmware profile plus flight-controller **parameters**:

| Setting | Value | Why |
|---|---|---|
| `SERIAL2_PROTOCOL` | `2` (MAVLink 2) | the companion's port |
| `SERIAL2_BAUD` | `921` (921 600 baud) | headroom for position setpoints and telemetry |
| `FS_GCS_ENABLE` | RTL (or SmartRTL) | the backstop if the **companion** dies |
| `FS_GCS_TIMEOUT` | the default 5 s, or a little more | shorter than any relay window: a dead companion is caught fast |
| RC failsafe (`FS_THR_ENABLE`) | RTL | the pilot's ELRS kill switch, unchanged |
| Fence (`FENCE_ENABLE` and its polygon) | the corridor | a second fence under the controller's |

**How the two failsafes split the work.** The companion sends MAVLink heartbeats *as the ground
station* (the system id the flight controller is configured to accept as its GCS) for as long as
the companion process is healthy. That makes ArduPilot's GCS failsafe mean exactly one thing:
**the companion stopped**. The *chain's* link logic — inner link quiet, shift inward, RTL after the
window — is the companion's own rule, acted on through ordinary GUIDED setpoints and an RTL mode
switch. ArduPilot's documentation notes that once its GCS failsafe fires, the copter stays in the
failsafe mode even if heartbeats return, so the backstop cannot be undone by a flapping link.

**What the core already speaks.** The drone node's `MavlinkDroneProvider` flies GUIDED position
setpoints, switches to RTL and LAND, and requires MAVLink 2 signing in both directions; it was
proven against ArduPilot SITL (ADR-099 evidence). It dials MAVLink over **TCP**, so on the Pi a
serial-to-TCP router (mavlink-router is the usual one) connects it to the flight controller's
UART. The relay-only fit speaks MAVLink from the ESP32 directly and needs no router.

## 4. Two layers of protection on every hop

- **Link layer.** ESP-NOW's per-peer encryption between neighbours (within the 17-peer limit)
  stops passive eavesdropping on each hop.
- **End to end.** The relay envelope's MAC is computed by the source over everything a relay must
  not change and checked by the destination with the key it received at enrolment. A relay can
  forward, drop or delay — it cannot forge a command or a heartbeat, and it never needs the key.
  The replay window refuses a captured envelope sent again.

This keeps ADR-099's property on a chain: no raw vehicle link is exposed, every command is
authenticated where it executes, and the node that executes it logs it.

## 5. The range test — before any catalog row is trusted

The package sizes chains from a link budget whose default environment exponent (2.2) is an
air-to-air assumption; Espressif's ground-level result above fits an exponent nearer 3. Measure:

1. **Rig.** Two boards with the exact antennas, mounting and orientation that will fly. One
   transmits numbered ESP-NOW frames (1000 per point, the relay's real frame size); the other logs
   RSSI and the delivered fraction.
2. **Ground pass.** Both ends at 1.5 m, 50 m steps until delivery falls below 50 %. This should
   reproduce Espressif's figures; if it does not, stop and find out why.
3. **Height pass.** One end at the relay band's height — on a mast, or on a drone hovering inside
   the base link's own range — and the same steps. This is the number the chain flies on.
4. **Fit.** RSSI against log-distance gives the exponent; the distance where delivery falls below
   90 % gives the effective sensitivity. Repeat in long-range mode.
5. **Record.** Replace the `esp-now` and `esp-now-lr` catalog rows with the measured sensitivity
   and state the exponent in the row's `source` (date, boards, antennas, heights, site). Keep the
   raw log with the store package's evidence.

**Done when:** the catalog rows carry measured numbers with their source, the package's sizing
tests are updated to them, and a chain designed on the measured rows keeps its design margin at
the hop in the height pass.

## 6. Bring-up, each stage gated

| Stage | What | Gate |
|---|---|---|
| R1 bench | three ESP32-C6 boards on a desk bridged to three drone-node processes; a command envelope relayed base → r1 → tip and the reply back | the package's B1 done-when, over real radios |
| R2 range | §5 | the catalog rows are measured |
| R3 SITL | ArduPilot SITL behind a drone node with the relay role; a relay node between it and the controller; kill the relay | the tip shifts inward and returns on its own rule; the controller logs the gap and the reconnection |
| R4 hand-carried | relays on poles or carried along the corridor; the tip's heartbeat arrives through the chain; switch one relay off | the measured outage is within the simulation's for the same corridor and measured rows |
| R5 flight | three drones, a corridor short enough that the tip is still inside the base's own link, as a fleet mission behind the confirm | a relay lost in flight costs no more than the simulated outage, and a failure falls back to the direct link |

Nothing flies before R3 passes, and R5 starts inside direct-link range so every failure mode has a
fallback.

## 7. Parts (indicative — verify at order)

| Part | Qty | Role |
|---|---|---|
| ESP32-C6 module or small board with a U.FL connector | 1 per drone + 1 base | the drone-to-drone radio |
| 2.4 GHz 2 dBi dipole with a U.FL pigtail | 1 per board | the antenna the long-range row assumes |
| 4-wire lead to the flight controller's TELEM2 | 1 per relay-only drone | MAVLink 2 at 921 600 baud |
| USB lead (Pi or ground station) | 1 per bridge | the frame bridge |
| SX1262-class LoRa module (only for a LoRa chain) | 1 per drone | the kilometre, commands-only fit |

The catalog in the package names the module each transport implies and states where its numbers
come from; the range test replaces them.

## 8. What stays open

The operator's decisions are ADR-155's Q1–Q4 (first radios, where the relay role lives first, the
link model, trees). The package BACKLOG carries B1 (the relay role on the drone node), B2 (the
ESP-NOW transport adapter), B3 (frame loss below the edge), B4 (corridors from the map), B5 (two
tips) and B6 (the formation handed to Drone Ops as a draft) with done-when criteria.
