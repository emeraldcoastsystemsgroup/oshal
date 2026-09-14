# Animatronic prop hardware — the parts, the power rule, and the builds worth copying

Companion to [ADR-156](../adr/156-animatronic-props-as-a-peripheral-kind.md) and the store package
`animatronics`. Everything here is indicative and must be verified against the parts actually
bought; the package's servo catalog carries a source line per row for the same reason.

## 1. The shape of a prop

A character shell over a **relatively dumb machine**: gimbals, rotary joints and a rigid frame,
with the intelligence in software. Not a humanoid skeleton in a costume. The mechanisms the
package models, in the order they are worth building:

| Mechanism | Servos | Notes |
|---|---|---|
| Eyes, two-axis gimbal | 2 micro | One servo pans the pair, one tilts. Start here: it avoids the linkage work that dominates classic eye mechanisms. |
| Eyelids | 2–4 micro | Upper and lower, or one per eye. Metal gears: the lids move fastest of anything on a face. |
| Neck | 2–3 standard | Yaw and pitch carry the head's mass; roll is optional and usually skippable. |
| Jaw | 1 standard | Chatter is short, repeated swings; a half-open swing is followable where a full one is not. |
| Arm | 3–6 | Bus servos (position, load and temperature readback on one serial line) rather than PWM once past three joints. |

## 2. Power is the thing that bites

**Logic power and actuator power are separate rails.** The microcontroller's 5 V pin and the USB
port are not an actuator supply. Give the servos their own 5–6 V supply sized for their summed
current, share **only ground** with the controller, and fuse the servo rail.

Rules of thumb the package turns into refusals:

- A moving micro servo draws roughly 200–250 mA; a standard 55 g servo roughly 500 mA; stall is
  three to five times that.
- Budget the **peak frame**, not the sum of everything: only the servos moving at that instant
  draw moving current.
- The **all-stalled** figure is the brown-out case. A seven-servo skull can stall past 10 A on a
  6 V rail; a jammed mechanism will reset the controller unless the rail is sized or fused for it.
- A single micro servo on USB for a bench test is fine. Two is not.

## 3. Controller

An ESP32 or Arduino driving a **PCA9685** 16-channel PWM driver over I²C at 50 Hz, chained to 32
outputs if needed. The driver's V+ terminal is the servo rail and is separate from its VCC logic
pin; its OE pin is the hardware "all outputs off" the e-stop drives. Past three or four joints on
an arm, prefer **serial bus servos** (Feetech STS-class and similar): one line, addressable ids,
and position/load/temperature back.

The controller runs the reference sketch in the package
(`firmware/esp32-pca9685/animatronics_controller.ino`), which verifies a checksum on every line,
clamps every pulse to the limits the host sent, latches on e-stop, and turns outputs off after
three seconds of silence. **Posture:** that sketch is reference source. It has not been compiled
or bench-run; the protocol it implements is proven by the package's encoder and parser tests, and
the bench proof is [BACKLOG](../BACKLOG.md) work.

## 4. Servos worth knowing

| Class | Example | Use |
|---|---|---|
| 9 g micro, plastic gears | SG90 | Eyes, light lids, prototypes |
| 9–13 g micro, metal gears | MG90S | Lids and anything that moves fast or takes a knock |
| 55 g standard, metal gears | MG996R | Neck, jaw |
| Digital, high torque | DS3218 class | A heavy head or a lifting mechanism |
| Serial bus | Feetech STS3215 class | Arms; readback, daisy-chained |

Speed matters as much as torque: a servo rated 0.1 s per 60° moves 600°/s, and a cubic ease-in-out
peaks at **three times** a motion's average speed. That is why a fast blink is commanded linear.

## 5. The open builds worth copying

The operator's survey, recorded so the reasoning behind the design is traceable. None of this code
is vendored; what we took is the shape.

| Build | What it is | What we took |
|---|---|---|
| Two-axis animatronic eye (Adafruit) | A pan/tilt gimbal instead of eye linkages | The first mechanism, and the argument for it |
| ServoEye | PC vision over a serial link to a microcontroller driving micro servos | The split: the computer thinks, the controller drives |
| "Phil", Zappo-II class ESP32 eyes | Six servos on a PCA9685 with a 5 V/3 A rail, calibration and joystick tools, a web UI | The six-servo face template, and calibration as a first-class artifact |
| Doorman, Robin-Sch, six-servo dual-eye builds | Printed eyeballs, lids, U-joints, linkage lessons, explicit warnings against USB power for six servos | Mechanical cautions and the power refusal |
| PiBob | A cheap printed robot with a slider UI, servo reversing and pulse tuning | The calibration table: reversal and pulse range per channel |
| WALL-E Dora | Head, arms, sounds, calibration, diagnostics, gamepad and browser control, motion sequences, power monitoring | The "animatronic operating system" framing: sequences, diagnostics and power as one system |
| Glicksman animatronics | Scenes (a combination of servo positions) and scenarios (a timed script of scenes) | The behaviour model, adopted almost verbatim as poses and scenarios |
| AM-ARM | A printable 6+1 DOF arm on Feetech bus servos, about 52 cm reach, 1 kg payload | The arm family: motor → bracket → motor, with bus servos rather than imitated muscles |
| Open 2-DOF robot head | Yaw motor, pitch motor, brackets, base | The neck shape |
| Korosuke | A robot that sees, listens, talks and waves, with an ESP32-S3 and a ROS 2 workspace | Higher-level engine ideas only; ROS stays an adapter, never the substrate ([ADR-151](../adr/151-eyes-and-hands-embodied-swarm.md) D2) |

## 6. Bring-up order

1. **Bench the supply first.** Servo rail up, meter on it, controller on its own supply, grounds
   tied. Nothing else connected.
2. **One channel.** Flash the controller, connect from the app, arm, and jog one servo. Confirm
   the pulse clamps hold at both ends before anything is attached to the mechanism.
3. **Calibrate.** With the horn on the mechanism, set the rest angle, then the software limits to
   what the linkage actually allows, then the reversal. Save; the rig disarms and re-validates.
4. **Rehearse before you power the mechanism.** Read the per-channel lag and the supply verdict.
   Fix a refusal by slowing the move, shortening the travel, commanding it linear, or choosing a
   faster servo — not by removing the limit.
5. **Then behaviour.** Blink, idle, look-at, and only then the character's own scenarios.
6. **Keep the e-stop reachable.** It turns the outputs off at the driver and disarms the rig, and
   it is the one control that never waits for a confirm.
