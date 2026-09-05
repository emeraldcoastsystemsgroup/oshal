# ADR-140 — Local device access: a node-resident device broker (Bluetooth first)

**Status:** Proposed — design only; **P0 gate CLEARED 2026-09-04** (amendment A). Operator directed the shape 2026-09-04 (*"spec it out, let's do it,
desktop first, and yes printers, 3D printers, headphones"*). **No core code is built against this yet**;
per Rule 0d the core is not touched until this ADR is accepted.

**Date:** 2026-09-04

**Related:** [ADR-135](135-print-to-swarm-and-print-to-rag.md) (print-to-swarm; amendment H established the
node-resident service pattern this reuses wholesale), [ADR-114](114-user-owned-remote-nodes.md) (user-owned
nodes, device-bound credentials), [ADR-047](047-smart-home-edge-agent.md) (edge agent for smart home),
[ADR-036](036-bot-owned-application-architecture.md) (the bot owns the domain; the surface is a view),
[ADR-137](137-deploy-modes.md) (deployment posture).

---

## Context

### There is no Bluetooth in oshal today

Searched end to end. Bluetooth appears in exactly four places, and **none of them is an implementation**:

| Location | What it actually is |
|---|---|
| `src/features/camera/model/camera-types.ts:23` | `'ble'` as a member of the type union `CameraLink = 'usb' \| 'ap' \| 'cohn' \| 'ble'` |
| `src/app/camera-node-server.ts:61` | `if (link === 'ap' \|\| link === 'ble') return 'http://10.5.5.9:8080'` — BLE is handled *as if it were WiFi AP*; the file header says BLE provisioning "is a follow-up" |
| `src/features/camera/services/gopro-camera-provider.ts` | comments only: BLE is "a node-side follow-up" |
| `packages/oshal-print-drop/bin/print-drop.js:229` | a Windows menu string: *"Settings > Bluetooth & devices > Printers & scanners"* |

**No Bluetooth library exists in any `package.json`** — no `noble`, `@abandonware/*`, `bleno`, `node-ble`.
The only backlog item ([BACKLOG.md:629](../BACKLOG.md)) is narrow: *"add GoPro BLE AP/COHN provisioning"* —
Bluetooth purely as a bootstrap to hand a camera its WiFi credentials.

### The physical constraint that decides the architecture

A Bluetooth radio is **local**. A Bluetooth device has no routable address, so nothing can reach it from
elsewhere on a network; the initiator must be physically within radio range. That has a hard consequence:

> **The swarm runs in Docker, and containers have no radio.** Docker Desktop on Windows exposes no host
> Bluetooth adapter and no BlueZ socket to pass through. No amount of code added to the controller can make
> the swarm speak Bluetooth.

This is the same shape as ADR-135 amendment G/H one layer down. There, discovery was link-local *multicast*
and could not cross a layer-3 overlay. Here the radio is link-local *physics* and cannot cross anything at
all. The answer is the one the operator already reached for printing: **the hardware lives on a node, and
only results cross the network.**

### The finding that changes the scope: the named devices do not share a transport

The operator named printers, 3D printers, and headphones. Read literally as a Bluetooth feature, a
Bluetooth-only service would deliver **one** of those four classes:

| Device class | Assumed transport | What it actually is |
|---|---|---|
| Headphones / speakers | Bluetooth | The **OS** owns A2DP pairing. An application selects an **audio output sink**; it never speaks the Bluetooth protocol. This is an audio-routing concern. |
| Bluetooth printers | Bluetooth | Usually SPP/RFCOMM carrying ESC-POS. On Windows the OS already surfaces a paired BT printer as a **system printer** — at which point ADR-135's IPP rail already covers it. |
| 3D printers | Bluetooth | Overwhelmingly **USB serial** (Marlin/Klipper G-code over CDC) or **network HTTP** (Moonraker, OctoPrint). Bluetooth is rare and usually a bolt-on module. |
| Sensors, beacons, wearables, ESP32, hobby hardware | Bluetooth | Genuinely **BLE GATT**. This is the real Bluetooth case. |

Building a Bluetooth-only service would therefore satisfy the request as worded and fail it as intended.
The three non-BLE classes need serial, audio-sink selection, and (already shipped) IPP.

The good news is that the expensive parts are **shared across all of them**: node residency, the pairing
gesture, per-device authorization, identity translation, and the swarm-facing call path. The transport is
the cheap, pluggable part. So this ADR specifies a **device broker with pluggable transports**, with BLE as
the first and headline transport.

### What makes this tractable now

`packages/oshal-chat` is **Electron 43.3.0**, and Electron exposes Web Bluetooth, Web Serial and WebUSB
through **one** permission and chooser model. That means BLE, 3D-printer serial, and USB peripherals are
reachable with **no native module, no build toolchain, and no per-OS binary** — which is what has made
Node.js Bluetooth painful on Windows historically (`noble` needs WinRT bindings; `node-ble` is BlueZ-only).

---

## Decision

### D1 — The device broker is node-resident, with the node's lifecycle

A `DeviceBroker` in `packages/oshal-chat`, started and stopped exactly where `PrintService` already is
(ADR-135 amendment H): `connect()` starts it after enrolment; `teardownClient()` stops it.

- **Opt-in, default OFF** (`deviceBrokerEnabled`), matching `printServiceEnabled` and `allowSystemControl`.
  Handing the swarm access to physical hardware is outward-acting.
- It refuses to start without a `clientId`, without a node credential, or on a node whose owner is unset —
  a device reading is a *person's* data and there must be someone to attribute it to.

### D2 — Transports are adapters behind one interface

| Transport | Electron API | Main-process hook | Covers |
|---|---|---|---|
| **BLE GATT** | `navigator.bluetooth` | `select-bluetooth-device` | sensors, beacons, wearables, ESP32/hobby hardware, BLE-equipped printers |
| **Serial** | `navigator.serial` | `select-serial-port` | **3D printers** (Marlin/Klipper G-code), CNC, Arduino |
| **USB** | `navigator.usb` | `select-usb-device` | direct USB peripherals |
| **Audio sink** | `enumerateDevices` + `setSinkId` | *(no chooser)* | **headphones/speakers** — routing to an already-paired output |
| **Network/IPP** | *(already shipped)* | — | **printers**, via ADR-135's print rail |

One `DeviceAdapter` interface: `list()`, `connect(id)`, `read(op)`, `write(op)`, `disconnect(id)`. Adding a
transport is a new adapter, nothing else — the same discipline as the graph connector in ADR-045.

### D3 — Pairing is a human gesture; use is automated

This is a property of Web Bluetooth/Serial, and it is a **feature, not a limitation**: the chooser cannot be
driven headlessly, so nothing the swarm dispatches can silently pair new hardware.

- **Pair once, at the node, by a person** — through the node's own device pane.
- **Reconnect automatically thereafter**, via Electron's `session.setDevicePermissionHandler` persisting the
  grant, so an unattended node re-attaches to known devices after a reboot.

Consequence to accept openly: a brand-new device always requires someone at that machine. There is no remote
onboarding of hardware, by design.

### D4 — Three authorization states, default deny at each

1. **Paired** — the OS/Electron knows the device (human gesture, D3).
2. **Granted** — the node's owner has explicitly said *the swarm* may use this device. Pairing alone never
   implies this.
3. **Scoped** — each granted device carries an allowlist of permitted operations.

Mirrors the existing `allowSystemControl` posture: present, explicit, and off until someone turns it on.

### D5 — Operations are exact and schema-bounded; the model never gets a radio

Following the connector doctrine in CLAUDE.md, a device operation is a **deterministic, schema-bounded
server operation**, not a model-visible tool environment. The model never receives a GATT handle, a serial
port, or an open G-code pipe. It requests `printer.getTemperature` or `sensor.readHumidity`; the node
executes exactly that and returns a normalized result.

Every operation is classified:

| Class | Meaning | Gate |
|---|---|---|
| `read` | observe state (temperature, battery, humidity) | owner grant is sufficient |
| `write` | change a non-physical setting | owner grant + operation in the device's allowlist |
| `actuate` | **cause physical action** — heat a nozzle, move a motor, unlock | allowlist **plus** an explicit per-call confirm, unless the owner has pre-authorized that exact operation on that exact device |

`actuate` exists because the failure mode is not a bad answer, it is a hot nozzle or an open door.

### D6 — The swarm calls the node over the existing task rail, not a new inbound channel

A node may sit behind NAT with no inbound reachability, so the swarm must never need to connect *to* it.
Device operations ride the **existing** `TaskWorker` pull and the durable task journal:

```
swarm enqueues a device task
  -> node's worker claims it on its own plane (node-bound token, already scoped)
  -> broker executes against the local device
  -> result settles back through the task journal
```

Nothing new is invented for transport, and the node-token scope needs no change — the same conclusion
ADR-135 amendment H reached, for the same reason.

### D7 — Identity translation, exactly as the print intake does it

A device belongs to a **person**, not to a machine. Reusing the D22 pattern:

| Fact | Established by | Never trusted from |
|---|---|---|
| *which node* is reporting | the node-bound token's binding | — |
| *whose device* it is | the registry record's `ownerSub` | the request body |
| what is returned | a normalized result | never a raw handle |

An unowned node cannot broker devices at all.

### D8 — Desktop first; phone is explicitly out of scope for v1

Operator instruction. Recording *why*, so it is a decision and not an oversight:

- **There is no mobile client today.** The only mobile artifact in the repo is `.mobile-assess.mjs`, a
  Playwright script that renders the cockpit at a 390x844 viewport. Mobile means "the web cockpit in a phone
  browser".
- **A phone node would have to be a native app.** iOS gives web pages no Bluetooth API at all and restricts
  background BLE severely; Android's Web Bluetooth is usable but backgrounding is unreliable.
- A phone is the *better* host for wearables and proximity sensing, so this is a deferral, not a rejection.

### D9 — What this is not

- **Not a smart-home replacement.** ADR-047's edge agent owns Wi-Fi/cloud-API home devices. This is the
  local-radio/local-port tier beneath it.
- **Not a second printing path.** A paired Bluetooth printer that Windows exposes as a system printer is
  served by ADR-135 already. The broker does not re-solve printing.
- **Not remote pairing.** See D3.

---

## Phasing

| Phase | Scope | Done when |
|---|---|---|
| **P0** | Live-verify Electron Web Bluetooth + Web Serial on this Windows box before any design is committed to | A throwaway Electron window enumerates a real BLE device and a real serial port on `PARENTPC` — **or** the finding is recorded and this ADR is revised |
| **P1** | Broker skeleton + BLE adapter + device pane (pair, grant, revoke) + `read` ops only | The owner pairs a real BLE device at the node, grants it, and a swarm-dispatched task returns a real reading attributed to the owner |
| **P2** | Serial adapter (3D printer): `read` temperature/progress, `write` settings; `actuate` behind confirm | A real 3D printer reports state to the swarm; a heat command requires an explicit confirm |
| **P3** | Audio-sink adapter — enumerate and route to a paired BT headset/speaker | Jarvis speech comes out of a chosen Bluetooth speaker |
| **P4** | Device catalog surface in the cockpit; per-device operation allowlists editable by the owner | An owner sees every device across their nodes and edits its allowlist |
| *(deferred)* | Phone node (native), per D8 | — |

**P0 is a gate, not a formality.** Everything above rests on Electron's Web Bluetooth working on Windows,
which **I have not run on this machine**. If it does not, the fallback is a native module per OS and the
cost of P1 changes materially — which the operator should know before, not after.

---

## Consequences

**Good**
- One authorization model covers BLE, serial and USB, because Electron already unifies them.
- No native modules, no per-OS binaries, no build toolchain — historically the reason Node.js Bluetooth on
  Windows is painful.
- Reuses proven rails end to end: node lifecycle (ADR-135 H), node-plane token scope, the task journal,
  device->owner translation. The genuinely new code is the adapters and the device pane.
- Pairing being human-gated makes the dangerous case structurally impossible rather than policy-blocked.

**Costs and risks**
- **Hardware cannot be onboarded remotely.** A person must be at the machine once per device.
- **BLE is flaky in the real world** — range, adapter driver quality, and Windows' BLE stack. Guards must
  tolerate a device that is simply out of range without failing a ticket.
- **`actuate` is genuinely dangerous.** The confirm gate is load-bearing and must not be softened for
  convenience later.
- **A fourth device tier** joins cameras (ADR-102 style nodes), smart home (ADR-047) and printers (ADR-135).
  The boundary in D9 has to be enforced or these will overlap.

---

## What I need from the operator to proceed

1. **Accept or amend this ADR** — core is untouched until then.
2. **P0 first?** Recommended: spend one short session proving Electron Web Bluetooth on `PARENTPC` before
   building P1 on the assumption.
3. **A real device to target for P1.** BLE with a standard GATT profile is easiest (a heart-rate strap, a
   thermometer, an ESP32). Naming the actual device makes P1 provable rather than theoretical.
4. **Confirm the `actuate` gate** — specifically whether pre-authorizing an operation per device is
   acceptable, or whether every physical action should confirm every time.

## Open questions

- **Q1** — Should a device grant be per **node** or per **owner across nodes**? Per-node is simpler and
  matches how devices physically attach; per-owner is friendlier when someone has two machines.
- **Q2** — Should device readings land in a time series (`oshal-local-tsdb` already runs) or only answer
  live queries? A sensor that is only readable on demand is much less useful, but persisting readings makes
  this a data-retention decision.
- **Q3** — Does a device grant survive node **re-enrolment**? It should probably be revoked, since the
  credential changed, but that costs the owner a re-grant after every rotation.

---

## Amendment A — P0 ran, and it passed (2026-09-04)

The ADR above recorded P0 as a gate with the caveat *"I have NOT run it on this machine."* It has now
been run, on `PARENTPC`, with a throwaway Electron probe that paired nothing and cancelled every chooser
it opened. **The gate is cleared and the design holds.**

### What the probe proved

| Check | Result |
|---|---|
| Electron / Chromium | **43.3.0 / Chrome 150.0.7871.212** |
| `navigator.bluetooth` / `serial` / `usb` / `hid` in the renderer | all present (`object`) |
| `window.isSecureContext` under `file://` | **true** — Web Bluetooth's secure-context requirement is satisfied without hosting the page |
| `session.setDevicePermissionHandler` | **present** — the hook D3 relies on for automated reconnection is real |
| `session.setBluetoothPairingHandler` | **present** |
| `select-bluetooth-device` fired | **yes** — Chromium started a real scan and the Windows Bluetooth layer answered |
| `select-serial-port` fired | **yes** |
| Host Bluetooth hardware | **present and running** — 35 Bluetooth PnP devices, `bthserv` Running |

`executeJavaScript(code, /* userGesture */ true)` is what let the probe call `requestDevice()` at all —
both Web Bluetooth and Web Serial require a user gesture, and that flag is the sanctioned way for the main
process to supply one. **P1 needs it; without it `requestDevice` rejects.**

One incidental trap worth recording, because it cost the first probe run: **`ELECTRON_RUN_AS_NODE=1` in the
environment makes the Electron binary run as plain Node**, at which point `require('electron')` fails with
`MODULE_NOT_FOUND` and the failure looks like a broken Electron install. Clear it before launching.

### The finding that matters more than the pass

**The scan returned zero devices — and that is the ADR's central scoping claim, confirmed empirically
rather than asserted.**

This machine has two pairs of AirPods and a BT5.0 mouse paired and working. None of them appeared. That is
not a bug and not a range problem:

- **AirPods are Bluetooth Classic (A2DP/AVRCP)**, which Web Bluetooth **structurally cannot see** — the
  spec covers BLE GATT only. The probe listed them via Windows PnP (`Dad's AirPods Avrcp Transport`,
  `Jennfffer's AirPods - Find My Avrcp Transport`) while the Web Bluetooth scan showed nothing.
- **Already-connected peripherals stop advertising** as connectable BLE devices, so a fresh scan does not
  surface them either.

So the transport table in the Context section is now evidence, not analysis: **headphones will never be
reachable through the Bluetooth adapter, on this machine, today.** The audio-sink adapter (P3) is not a
convenience — it is the *only* path to the headphone case, exactly as designed.

### What P0 did NOT prove

Stated plainly so nobody reads more into this than it earned:

- **No device was actually connected.** The probe cancelled every chooser by design. A real GATT
  read remains unproven until P1 has a device to target.
- **No serial port was present** (`GetPortNames()` returned none — nothing plugged in), so the serial path
  is proven only as far as the chooser firing. A real 3D printer is still needed for P2.
- Grant **persistence across restarts** was not exercised; only the presence of the handler was.

### Consequence for the phasing

P0 is **done**. P1 can begin on the strength of it, and the "fallback is a native module per OS" risk the
ADR carried is **retired** — Electron reaches both the radio and the serial bus on this platform.

The one input still outstanding is item 3 in *What I need from the operator*: **a real BLE device to target
for P1.** The empty scan makes that concrete rather than theoretical — a device that advertises as a BLE
GATT peripheral (a heart-rate strap, a BLE thermometer, an ESP32 running a GATT service) is required, and
the AirPods and BT mouse already on this machine will not serve, for the reason above.
