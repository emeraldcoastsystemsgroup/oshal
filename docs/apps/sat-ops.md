# Sat Ops — operator guide (as-built)

Open **`/cockpit/?app=sat-ops`** (or the globe icon labeled *Sat Ops* on the ribbon). The
in-surface **? Help** button carries a condensed version of this guide.

Satellites are swarm nodes (ADR-102, drone-ops pattern): each sat node runs its own ADCS —
6-state MEKF attitude estimation, a SAFE/DETUMBLE/SLEW/POINT/DESAT mode manager, quaternion-PD
pointing, magnetorquer momentum dumping — against a simulator engine and joins the fleet via
authenticated heartbeats. **Every engine is a simulator; commands cannot reach hardware by
construction, and every command additionally requires an explicit operator Approve.**

## The two identities of a sat

| identity | where it lives | how it appears |
|---|---|---|
| **Attitude node** (a running process) | `npm run sat:node` host-side, or a NASA 42 container behind one | *Fleet* panel row, heartbeating mode/error/momentum/MEKF telemetry |
| **Orbit** (a TLE) | the in-memory catalog (`PUT /api/sat/catalog/:satId`) | *Orbit catalog* row; orbit in the 3D console; ground track on the map |

They are deliberately decoupled and join by sat id. A catalog entry alone renders orbits but
never heartbeats; a node alone commands fine but draws no orbit.

## Panels

- **3D console** — drag to orbit the camera, wheel to zoom, `auto-rotate` toggles idle spin.
  `frame: inertial` = ECI (TEME) with the graticule turning at GMST; `frame: earth` holds the
  globe still. The selected sat draws its body-axis triad from the node's live quaternion.
  Rings with km labels mark conjunction events at their time of closest approach.
- **Ground track** — equirectangular subpoint tracks with the ground-station marker.
- **Fleet** — online dot, ADCS mode chip, pointing error. Click to select.
- **Orbit catalog** — paste any 2/3-line element set, or *Seed demo fleet* (an ISS-class
  leader, a 0.05°-mean-anomaly chaser ~5.9 km behind it, and a polar bird).
- **Conjunction screening** — pairwise SGP4 close-approach search over the catalog within the
  horizon; refined TCA, miss distance, relative speed. Screening aid only: TEME point
  geometry, no covariance, no collision probability.
- **Selected sat** — mode + transition reason, pointing error, wheel momentum (`dumping` when
  the rods are active), body rate, MEKF health (updates / rejections / reinits, attitude σ,
  gyro-bias estimate in °/hr).
- **Command console** — see below.
- **Sat operator** — the drafting concierge (see below).
- **Pass windows** — pick a catalog sat + ground station; 24 h of contacts via SGP4.

## Commands and the approve gate

| command | what it does | notes |
|---|---|---|
| SAFE | zero torque, sticky fault floor | never auto-exits; operator command only |
| DETUMBLE | rate-damps the body | auto-completes to SAFE, or resumes a latched target |
| DESAT | magnetorquer momentum dump, body held quiescent | returns to the latched target at ≤40% momentum; dump rate is dipole-limited physics |
| POINT | slew axis (body frame) + angle | node runs SLEW→POINT with hysteresis; **refused (409)** while the attitude estimate is unhealthy |

Every send passes an Approve dialog that restates the sim-fleet doctrine. The mode manager
also acts autonomously: rates >3°/s in POINT trip DETUMBLE, momentum ≥95% escalates to DESAT,
≥70% starts a concurrent dump, and a persistent estimator fault falls to SAFE.

## The sat-operator concierge (drafts only)

Type intent in plain language — *"point sat42-live 30° off current"*, *"why is momentum
high?"*. The concierge (a Form-B inline bot, drone-operator's sibling) replies and may offer a
draft. The route validates every draft (known online sat, whitelisted command, finite axis,
angle ≤ 60°); **Load draft** only pre-fills the command console — sending still requires your
button press and Approve. The concierge can never actuate.

## Running sat nodes

```bash
# host-side (session-bound, like drone nodes); secret from .env
SWARM_SERVICE_SECRET=<secret> SAT_NODE_ID=sat-1 SAT_NODE_PORT=4200 \
SAT_NODE_ENDPOINT=http://host.docker.internal:4200 OSHAL_API_URL=http://localhost:35457 \
SAT_ENGINE=rk4 SAT_SENSOR_MODEL=cfs SAT_MAG_ENV=true npm run sat:node
```

- `SAT_ENGINE=rk4` — in-process gyrostat truth sim; `SAT_SENSOR_MODEL=cfs|mems` wraps it in
  synthetic sensors + the MEKF (recommended: the node then flies estimated state, exactly like
  the 42 path); `SAT_MAG_ENV=true` adds the rotating field + MTB rods so DESAT has physics.
- `SAT_ENGINE=nasa42` — fly the NASA 42 referee: start its container first
  (`docker run -p 10001:10001 -v <repo>/sim/nasa42/case:/opt/42/sat-ops oshal-sat42:latest`)
  and set `SAT42_HOST/SAT42_PORT`. 42 keeps truth; the node sees sensed state only.
- The endpoint must be dialable **from the api container** — on Windows use
  `host.docker.internal`, not `localhost`.

## API surface (all under `/api/sat`, service-secret or OIDC)

`GET /fleet` · `POST /nodes/:satId/point` · `POST /nodes/:satId/mode` ·
`PUT|GET|DELETE /catalog[/:satId]` · `POST /track` · `POST /conjunctions` · `POST /passes` ·
`POST /chat` (concierge) · `GET /app` (this surface). Node heartbeats require the swarm
service secret — a node identity, never a browser.

## Evidence

`docs/evidence/sat-ops-adcs-campaign-*.md` — 200 seeded randomized closed-loop scenarios
(tumble→detumble, slew→settle, truth-scored hold, 30 s star-tracker outage ride-through,
momentum fault→autonomous DESAT recovery), 100% pass with physics-derived criteria. Live
NASA-42 missions and architecture: `docs/adr/102-sat-ops-satellites-as-swarm-nodes.md`.
