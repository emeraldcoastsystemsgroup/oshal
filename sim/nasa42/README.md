# NASA 42 — the independent attitude referee (ADR-102)

This directory builds [NASA's 42 spacecraft simulator](https://github.com/ericstoneking/42)
into a headless container that exposes its **standalone-AC IPC socket** — the architecture 42
itself documents for controllers that live outside the sim process. The sat-ops slice's
`Nasa42SimAdapter` connects to it behind the same `SatSimAdapter` contract as the in-house
RK4 propagator, so scoring never runs on physics we wrote ourselves.

## Run

```bash
docker build -t oshal-sat42:latest sim/nasa42
docker run --rm -p 10001:10001 --name oshal-sat42 oshal-sat42:latest
# then, from the repo root:
npx ts-node -r tsconfig-paths/register --transpile-only scripts/sat-ops-42-smoke.ts
```

42 blocks at startup until the controller connects (that is `_AC_STANDALONE_` + blocking
accept, not a hang). One FSW cycle = 0.2 s sim time; the sim advances only as fast as the
controller answers, so wall-clock speed is paced by the socket round-trip.

## The case (`case/`)

42's stock `Standalone` demo case (CfsSat: 1,100 kg, 4-wheel pyramid, 3 body-axis gyros, star
tracker, magnetometers, CSS/FSS/GPS — all with their stock noise models) with exactly two
edits:

1. Graphics front end **FALSE** (headless).
2. **One** spacecraft instead of two (socket 10001 only).

Everything else — mass properties, the wheel pyramid, the star-tracker mount and its
Sun/Earth/Moon exclusion logic, sensor noise — is 42's own config. The adapter learns the
vehicle (MOI, wheel axes/limits, gyro axes, ST mount) from 42's table message at handshake,
not from anything hardcoded on our side. The ST mount is composed out analytically
(`qbn = q_meas ⊗ q_mount*`, transcribed from `42sensors.c`'s reversed-order QxQ), and the
adapter gyro-dead-reckons the attitude across ST exclusion outages — a frozen star tracker
must never freeze the control error (that exact failure was caught live on night 1).

## Protocol pin

The TS codec ([nasa42-codec.ts](../../src/features/sat-ops/services/nasa42-codec.ts))
transcribes the field-major binary layouts from 42's generated `Source/AutoCode/ScIPC.c` at
commit `18106c54` (the `FORTYTWO_REF` pinned in the Dockerfile). The handshake cross-checks
every computed layout length against 42's own BufLens message and refuses to run on a
mismatch — bump the pin and the codec together, never separately.
