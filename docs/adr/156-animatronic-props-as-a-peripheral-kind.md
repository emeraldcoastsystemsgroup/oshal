# ADR-156: Animatronic props are a peripheral kind — a calibrated rig, named behaviour, and a rehearsal before any pulse

**Status:** Accepted — BUILT 2026-09-14 as the store package `animatronics` 0.1.0 (store `023d583`).
Core is untouched apart from this record, its index row and the backlog entries it names.

## Context

The operator was building Halloween props and collected a set of open-source animatronic projects
(eye mechanisms on hobby servos, a six-servo face on an ESP32 with a PCA9685 driver, printed
two-axis "drone eyes", a printable bus-servo arm, whole robots with browser control, and a
scenes/scenarios behaviour model), then asked what was missing from our tooling.

**What already existed** (verify with the linked records before re-flagging):

| Layer | Where |
|---|---|
| A world to design and rehearse in, with drones as eyes and an arm as hands | [ADR-151](./151-eyes-and-hands-embodied-swarm.md), [ADR-152](./152-embodied-physics-and-training-lab.md), store `embodied` |
| A real CAD kernel and a print path | [ADR-153](./153-iterative-cad-kernel-cad-studio.md), [ADR-150](./150-deterministic-object-reconstruction-scan-to-print.md) |
| Circuits, motors, servos and gear trains in one SPICE solve | [ADR-154](./154-local-electromechanical-lab-circuit-lab.md), store `circuit-lab` |
| Every physical device as a swarm node with a capability manifest and a command log | [ADR-099](./099-drones-as-remote-swarm-nodes.md), [ADR-151](./151-eyes-and-hands-embodied-swarm.md) D1 |
| A talking prop with a face, a voice and lip-sync | store `pumpkin` |
| Animatronics and small-motor know-how as personas | `ai-lab/bot-personas/{animatronics,small-motors,robotics}-bot.yaml` |

**The gap was the middle layer.** Nothing turned "blink", "look at that person" or "talk" into
servo positions: no per-servo calibration or software limits, no pose or behaviour vocabulary, no
way to tell before powering a mechanism whether a servo can follow the motion or whether the
supply can carry it, and no wire protocol to a microcontroller. The reference projects each solve
that middle layer once, in firmware, for one prop.

## Decision

### D1 — The rig is calibration plus software limits, and the server owns every pulse

A prop is **channels** (one servo each: centre pulse, microseconds per degree, reversal, rest
angle, hard pulse clamps, rated speed) grouped into **mechanisms** with named roles — an eye
gimbal (pan, tilt), eyelids, a neck (yaw, pitch, roll), a jaw, an arm, or a custom set. Callers
speak **mechanism degrees** on an axis key (`eyes.pan`), never microseconds. A channel whose pulse
at either software limit would leave its hard clamps is refused at validation, before any frame
exists. The page never composes a pulse; it sends lines the server compiled.

### D2 — Behaviour is a pose library and timed scenarios (the scenes/scenarios model)

A **pose** names axis angles (`LOOK_LEFT`, `EYES_CLOSED`, `JAW_OPEN`). A **scenario** is a timed
script of steps: move to a pose or to angles over a duration with an easing, hold, run another
scenario, repeat, or run children **together**. Two concurrent children writing one axis is
refused, as are cycles and the step, depth, repeat and duration caps. This is the operator's
"LOOK_LEFT / BLINK / SURPRISED / IDLE_03" ask, and it matches the scenes-and-scenarios pattern the
reference projects converged on. The compiler expands it to a 50 Hz stream of angles and pulses;
the same rig, library and start pose always give identical frames.

### D3 — Rehearse on rate-limited servos and budget the supply before any pulse

Every stream runs through a **rehearsal**: each channel tracks its command no faster than its
rated speed, and the report gives per channel what the motion asked, what the servo is rated for,
the peak lag, the saturated frames and whether it settled. A verdict has three facets and all are
required. A **supply budget** counts current per frame — only the servos moving in that frame draw
moving current — plus the all-stalled worst case, and refuses a USB port carrying more than one
servo, a servo outside its voltage range, or a peak beyond the rail. Separating logic power from
actuator power is the single most repeated lesson in the reference builds and in the operator's
own bench experience; here it is a refusal, not a note in a README.

### D4 — An authority rail, and a concierge that cannot move the prop

`draft → rehearse → arm → play / look-at / jog → disarm`. Rehearsal needs no arming and moves
nothing. **Arm** needs an explicit confirm (428 without) and a supply the budget accepts (422
otherwise), and answers the controller bring-up lines. Play, look-at and jog answer 409 until
armed, re-rehearse from the pose the server believes the prop holds, and advance it. **Disarm** is
always allowed and is the e-stop. Every command is a row in an owner-scoped command log — the
ADR-151 D4 shape. The inline concierge holds tools for every draft and rehearse route and **none**
for arm, play or jog: a person arms a machine that can move, with the controller in front of them.

### D5 — The PC thinks, the microcontroller drives, over a documented line protocol

The reference projects split the work the same way: a computer does vision and behaviour, a small
controller drives the servos. We keep that split and put the intelligence on the server: the page
streams the server's frames over **Web Serial** to an ESP32 or Arduino driving a PCA9685. The
protocol (`oshal-animatronics/1`) is ASCII lines with an XOR checksum, delta frames with periodic
keyframes and heartbeats, controller-side clamps, a latching e-stop and a watchdog. One parser
serves both ends, and the browser loads the same compiled module the server writes frames with.
A prop is **not** a swarm node today: under [ADR-149](./149-enterprise-application-authorization.md)
enforcement a package-owned machine caller is refused on the box (the embodied backlog records the
same wall), so the browser session is the authenticated path until that decision changes.

### D6 — `prop` is a new peripheral kind, declared in the package until the vocabulary takes it

The rig publishes an [ADR-151](./151-eyes-and-hands-embodied-swarm.md) D1 capability manifest:
kind `prop`, safety class 1 (2 once a servo's stall torque reaches 10 kg·cm), senses
`channel-state`, `controller-hello`, `supply`, acts `pose`, `scenario`, `look-at`, `jog`, `arm`,
`disarm`, `e-stop`, with `e-stop` and `disarm` confirm-exempt. The kind vocabulary lives in
`embodied`, which was under an open claim when this shipped, so the package declares its own row
and a cross-package test pins its field set to embodied's and asserts embodied still refuses the
kind. That test goes red the day the fold-in lands, which is what makes the duplicate temporary
rather than permanent.

## Options considered

| | Chosen | Rejected |
|---|---|---|
| Where behaviour lives | Poses and scenarios as data, compiled server-side | Firmware sketches per prop (every reference project's approach): a new character means new firmware, and nothing can rehearse it |
| Safety | Software limits + rehearsal + supply budget + confirm to arm | Trusting the mechanism: the usual failure is a servo asked to move faster than it can, or six servos on a USB rail |
| Motion transport | The server's compiled frames streamed by the page | The page computing pulses: two sources of truth for the calibration |
| First mechanism | A two-axis gimbal for eyes | Linkage-driven eyeballs first; the gimbal is what the reference designs reach for to avoid fiddly linkages |
| Device identity | The person's browser session | A package-owned node on the swarm rail: refused by the ADR-149 gate on the box today |

## Consequences

- A prop's behaviour is inspectable, testable data, and the same rig can be rehearsed with no
  hardware present — the operator can design a character before the servos arrive.
- The refusals are the product: an unfollowable move, an under-sized supply and an out-of-limit
  angle are all caught before a mechanism is powered.
- What is deliberately not modelled: servo load, inertia, stall and dead-band (the rehearsal is
  rate-limited tracking, not dynamics); linkage geometry and collisions; sound and lip-sync; a bus
  servo's position readback. Each is a package backlog entry with done-when criteria.
- The reference firmware ships as source and has not been compiled or bench-run; the protocol it
  implements is proven by the encoder and parser tests, and the bench proof is a backlog entry.
- The parts hardware and the reference builds behind these decisions are in
  [animatronic prop hardware](../architecture/animatronic-prop-hardware.md).

## Related

- [ADR-151](./151-eyes-and-hands-embodied-swarm.md) — peripherals as nodes, the D1 manifest, the D4 command log.
- [ADR-154](./154-local-electromechanical-lab-circuit-lab.md) — the electrical companion; a servo is a part there.
- [ADR-153](./153-iterative-cad-kernel-cad-studio.md), [ADR-150](./150-deterministic-object-reconstruction-scan-to-print.md) — printing the mechanism.
- [ADR-149](./149-enterprise-application-authorization.md) — why a prop is not a node on the box yet.
- [docs/BACKLOG.md](../BACKLOG.md) — the follow-ons this record names.
