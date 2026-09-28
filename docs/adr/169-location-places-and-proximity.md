# ADR-169: Location, places and proximity

Date: 2026-09-28
Status: **Proposed.** Nothing in this ADR is built. The Context records what exists at core `main` `e1fd5b0f`
and store `main` `6fdc1a1`; every Decision item is a proposal. Acceptance is per slice: Q2 and Q4 before L2,
Q1 before L6, Q3 only before act-on-arrival within L8, and Q7 before L8 live acceptance. No core code is
written for a slice before its questions are answered (Rule 0d).

Related: [ADR-042](042-iot-connector-tenancy.md) (personal vs household ownership),
[ADR-044](044-mobile-companion-app.md) (phone companion), [ADR-100](100-ambient-person-model.md) (consent for
modelling people), [ADR-105](105-connector-write-actions-tier.md) (connector write audit),
[ADR-111](111-spatial-mapping-3d-reconstruction.md) (spatial mapping), [ADR-114](114-user-owned-remote-nodes.md)
(node ownership, unchanged here), [ADR-122](122-model-is-untrusted-principal.md), [ADR-124](124-rls-phase-2-table-walling.md),
[ADR-125](125-operations-stream-event-to-action-pipeline.md), [ADR-140](140-local-device-access.md) (the
`actuate` gate), [ADR-148](148-swarm-root.md) (swarm roles), [ADR-149](149-enterprise-application-authorization.md)
(application authorization), [ADR-157](157-scheduled-application-services-run-under-an-activated-principal.md)
(activated principals).

Paths are core-relative unless prefixed `store/`, which means the store repository.

## Context

### The request

The operator asked for a core location capability. People, devices and OSHAL Nodes (the "satellite bots",
`packages/oshal-chat`, whose README calls Jarvis mode "the swarm cockpit on a satellite", `:17`) should have a
location, so that the swarm can:

- use it when acting on requests ("order me food");
- let a drone that mapped a place with LiDAR load that historical layout the next time it is there;
- fire proximity reminders ("next time I'm at the grocery store, remind me …");
- fire proximity triggers ("open the garage door when I come home").

Devices and triggers may belong to a person or to "the general swarm". The operator also asked whether the
swarm needs a user separate from the people who use it, and whether one account acting as both swarm manager
and everyday user confuses the codebase.

### What exists today

| Area | As built | Where |
|---|---|---|
| OSHAL Node | Registers, then heartbeats every 10 s. Neither message has a location field. The platform enum is `macos\|windows\|linux\|unknown`. The registry is an in-memory Map. The durable rows are `client_id → owner_sub` and the node-bound credential `oshal_cli_tokens.node_client_id`; a node-bound token authenticates as the token's user. | `src/shared/types/a2a.ts:34,85-140`; `src/features/remote-client/services/remote-client-registry.ts:109`; `scripts/migrations/115-durable-remote-task-journal.sql:54-59`; `scripts/migrations/102-cli-token-node-binding.sql:14`; `src/app/routes/cli-token-routes.ts:255-267` |
| Node ownership | One person's sub, or unowned. Unowned is operator-only by default and open to any authenticated requester when `OSHAL_ALLOW_LEGACY_UNOWNED=true`. Access order: system → unknown denied → owner → operator → unowned. The gate decides whether work may run on the machine, which runs with `danger-full-access`. | ADR-114:51-61; `src/features/remote-client/services/device-access.ts:2-6,61-64,76-90` |
| Phone | Only the installable cockpit PWA, reached by QR code. There is no phone node. ADR-044 Phase 4 (`device.location`) is not built, and ADR-140 D8 says a phone node must be native. | `src/pages/cockpit/tools/devices.html:121-131`; ADR-044:57,70-87 |
| Drones | WGS-84 `GeoPoint` telemetry every 2 s, including live `position` and `home`. The controller keeps only the latest snapshot in an in-memory fleet. Drones have no owner and authenticate with `SWARM_SERVICE_SECRET`; the heartbeat's drone id comes from the body. The drone package returns live position to any authenticated caller. The sim drone's home is env-configured; MAVLink drones take home from the flight controller or the first fix. | `src/features/drone/model/drone-types.ts:33-38,127-128`; `src/app/drone-node-server.ts:112-113,173-184`; `src/features/drone/services/drone-fleet.ts:32,42-49`; `store/drone/src-routes/drone-routes.ts:288-293,378,387,511,527-537`; `src/features/drone/services/mavlink-drone-provider.ts:258,286,294-295` |
| Cameras | Deployment-level device nodes with no position field. | `src/features/camera/model/camera-types.ts:11` |
| Sat nodes | Simulated satellites. Orbit position comes from the TLE catalog as a lat/lon/alt subpoint track. | `src/app/sat-node-server.ts:14-16`; `src/features/sat-ops/model/orbit-types.ts:13-23,78-86` |
| Smart home | Hub devices are reached through the user's own SmartThings connection, and their index is a per-user `devices.json` with a room label only. Triggers are `clock` or `solar`; a solar trigger keeps browser lat/lng in the schedule's `taskData`. A fired schedule sends its saved prompt to the home-bot LLM. The only deterministic device writes are `/control` (switch on/off plus a free-form `set`) and `/scene/run`. | `store/home/src-routes/home-routes.ts:81,100,116,212,314-336,340,406`; `scripts/oshal-smartthings.js:248`; `src/app/home-schedule-dispatch.ts:5-6,88` |
| TVs | A free-text room per user, held in memory with a 90 s TTL, used only to route replies. | `src/app/routes/jarvis-voice-routes.ts:30-36,101-114` |
| Bots | Registry entries have no owner and no physical place. | `src/app/extensions/swarm/swarm-bot-registry.ts:40-100` |
| Store surfaces | eats, purchasing, rides, home and spaces each call browser geolocation separately. eats and purchasing save the fix as a text string. eats and rides put the saved address into the concierge prompt. | `store/eats/tools/eats-app.html:1162-1168`; `store/purchasing/tools/shopping-chat.html:1113`; `store/rides/tools/rides-app.html:1245`; `store/eats/src-routes/eats-routes.ts:301,315`; `store/rides/src-routes/rides-routes.ts:203` |
| Spatial maps | `spatial_scans` has no geographic anchor or place. `WorldFrame` is local-only. Capture GPS goes to a session JSONL that is not joined to the scan. Embodied scenes live in memory, 8 per owner, and embodied has a simulated voxel-map `relocalize`. ADR-111 scan and drone relocalization is not built. | `scripts/migrations/093-spatial-scans.sql:11-26`; `src/features/spatial-mapping/model/pose-types.ts:14-21`; `src/features/spatial-mapping/services/capture-telemetry.ts:10-24`; `store/embodied/src-routes/engine/world/imported-scenes.ts:22`; `store/embodied/src-routes/engine/sense/register.ts:291`; ADR-111:7 |
| Triggers | Every schedule is a cron. Jarvis reminders parse time phrases only. A user can hold one live `jarvis-reminder`, and it fires with no owner and no delivery. | `src/features/scheduling/types/schedule.ts:63-89`; `src/features/scheduling/services/schedule-service.ts:107-128`; `src/app/schedule-runtime.ts:173-199` |
| Geo helpers | `GeoPoint` and `haversineM` sit in the drone slice. The metres-per-degree constant is declared six times in core, and again in store `drone-relay`. | `src/features/drone/model/drone-types.ts:33-38`; `src/features/drone/services/mission-validator.ts:118-126`; constant at `drone-service.ts:50`, `fleet-mission.ts:26`, `fleet-patterns.ts:25`, `fleet-show.ts:37`, `sim-drone-provider.ts:51` (all `src/features/drone/services/`), `src/features/spatial-mapping/services/capture-plan.ts:163`; `store/drone-relay/src-routes/engine/fleet-draft.ts:28` |
| Geocoding | The rides script defaults to public OSM Nominatim (overridable with `OSHAL_GEOCODER_URL`), sends raw lat/lon on reverse lookups, and caches results for 30 days in a JSON file on the workspace volume that is mounted into the api and every bot. Weather has its own hard-coded, US-only client. | `scripts/oshal-uber-rides.js:170,390,398-410,543-557`; `any-bot/server/services/tools/weatherTools.js:101-105` |
| Spatial database | No PostGIS. The image is `pgvector/pgvector:pg16`. | `docker-compose.oshal-local.yml:675` |
| Personal graph `Place` | Off by default and held in memory. | `src/features/personal-graph/graph-types.ts:95-98`; `src/app/server.ts:1347-1355` |
| Minors | No account-level minor attribute. The only `is_minor` flag belongs to ADR-100 heard-speaker consent profiles. | `src/features/person-model/services/consent-gate.ts:50-69`; `src/features/person-model/services/person-model-schema.ts:112` |
| Step-up authentication | None. No route checks `max_age` or `auth_time`. | Search of `src/**/*.ts` for `max_age`, `auth_time`, `step-up` |

Five as-built rules shape every table this ADR proposes:

- **Owner RLS has an operator bypass, and more than root sessions carry it.** Both the stock owner policy
  and the personal-or-tenant policy pass every row when `oshal.is_operator = 'on'`
  (`src/shared/services/database/owner-rls-policy.ts:38-47`; `scripts/migrations/060-platform-rls-tenancy.sql:215-223`).
  The request middleware stamps that flag for root/admin sessions (`swarm_roles` or the env allowlist) and
  for every request that carries a valid `SWARM_SERVICE_SECRET` (`src/app/server.ts:767`;
  `src/shared/middleware/authz.ts:185-188`). A spec pins this as the "global compatibility stamp"
  (`tests/unit/machine-write-identity.spec.ts:579-584`). Drone, camera and sat nodes post over that rail
  (`src/app/drone-node-server.ts:178`; `src/app/camera-node-server.ts`; `src/app/sat-node-server.ts`), and
  every bot container holds the secret (`x-bot-env`,
  `docker-compose.oshal-local.yml:106,478`). A secret holder can also assert any user through
  `X-Oshal-User-Sub-B64` (`authz.ts:210-222`).
- **`SYSTEM_IDENTITY` is operator-stamped.** It has a null sub and `isOperator: true`
  (`src/shared/services/database/request-identity.ts:60-65`).
- **Unowned schedules are shared.** A schedule with no `ownerSub` is listed to every caller
  (`schedule.ts:74-76`; `schedule-service.ts:163-168`), and home schedules are created without one
  (`store/home/src-routes/home-routes.ts:404-406`).
- **Tenant membership is sub-only and is not a database fence.** Memberships are keyed `(tenant_id, user_sub)`
  with no issuer, and `oshal_is_tenant_member` compares only the sub (060:58-64,83-88). The helper has no role
  check, and the 060 policy it backs is `FOR ALL`. The membership table's own policy is `FOR ALL` with an
  operator branch and `WITH CHECK user_sub = current_sub` (060:291-304), so an operator-stamped session, or any
  session for its own sub, can insert itself into any tenant. The admin check for adding members is app code
  only (`src/app/routes/connector-tenancy.ts:418-462`).
- **Packaged surfaces run same-origin as the signed-in person.** Surface iframes carry
  `allow-scripts allow-same-origin` (`src/pages/cockpit/js/cockpit-view-controller.js:411`;
  `src/pages/cockpit/js/app.js:314`). The shell's own comment says package script in this origin could "call
  any API as them" (`app.js:287-288`). `uses:` declarations gate package server code, not surface script.

There is no geofence, place or presence trigger anywhere in core or store. The only matches for such terms
are drone flight fences and trading code.

## Decision

### D1. What has a location, and who owns its location data

A location belongs to a **subject**. There are two kinds of subject, and a bot is neither.

| Subject | Source of position | Notes |
|---|---|---|
| **Person** | Only the devices that person owns and has marked **carried**. | A person is never tracked directly, only through a carried device they opted in. |
| **Phone (cockpit PWA)** | Browser Geolocation, posted by the page while it is open. | The web API gives no position after the page closes. Continuous arrival detection therefore needs the native phone node (ADR-044 Phase 2/4, ADR-140 D8), which is outside this ADR. |
| **OSHAL Node (desktop)** | An **assigned place**, set by the owner in the Settings **Location** tab. | A stationary machine is modelled as "is at place P", not as a track. v1 takes no heartbeat fix (D7). |
| **Drone** | MAVLink `GLOBAL_POSITION_INT`, from the telemetry it already produces, posted to the core device ingest route under its own credential (D3, L6). | Embodied PX4 reports local NED only. It gets a place only through its scene's anchor (D3). |
| **Smart-home hub device, camera, TV** | An assigned place, plus a room label. | Hub presence sensors could be a later source, and are the kind of independent signal act-on-arrival needs (D4). SmartThings location and presence are not read today. |
| **Simulated sat-node** | Out of scope. | Its position is orbital simulator state from the TLE catalog, not a place. |
| **Bot** | None of its own. A bot-node is at the place of the host device it runs on; an inline concierge has no place. | A container has no place. "Where is the home-bot" means "where are the devices it controls". |

**`location_devices` records who owns a device's location data. It grants no control or execution right.**
It is never a second source of device-ownership truth:

- **Person-owned.** The owner is a person's subject (`owner_sub` + `principal_issuer`). For a node, only its
  ADR-114 owner (the registry `ownerSub` and the `remote_task_journal_client_owners` row) may enrol it.
- **Swarm-owned.** The owner is a tenant (`tenant_id`): an `oshal_tenants` row with its members in
  `oshal_tenant_memberships`, using the 060 personal-or-tenant shape without its `is_operator` branch (D3).
  A person may assign their own node's *location data* to a tenant they belong to. The node itself stays
  person-owned under ADR-114.
- **ADR-114 is not amended.** `canUseDevice` and `remote_task_journal_client_owners` are unchanged. That gate
  decides whether work runs on someone's computer with `danger-full-access` (`device-access.ts:2-6`), not who
  may see where it is. A tenant branch there would let any member dispatch work to a swarm node, which is the
  incident class ADR-114 closed. Tenant-usable nodes need their own ADR.
- **Drones and cameras** have no owner record. Only a swarm tenant admin may enrol one, and only to the swarm
  tenant.
- **Hub devices** are owned implicitly by the user whose SmartThings connection reaches them (per-user
  `devices.json`, `store/home/src-routes/home-routes.ts:100,325`). The `location_devices` row mirrors that
  owner, and the connection stays the only control authority.
- **Node credentials carry no location.** A node-bound token authenticates as the token's user
  (`cli-token-routes.ts:255-267`). Because v1 takes no heartbeat fix, that identity never attributes a
  location to anyone.

### D2. Principals: who manages the swarm, who uses it, and who owns the swarm's things

**The operator's question.** One account acting as both root and everyday user works today for one person.
The visible limits are two. The account's sessions bypass every owner policy. It also cannot erase itself
through `/api/me` (`src/features/data-lifecycle/services/exporter-registry.ts:185-188`). Management is
cleanly separated from business data in the application-authorization plane. It is not separated in the
database plane or in the older helpers. That starts to matter the moment a second person's data is on the
box, and location data is exactly that.

| | As built | Evidence |
|---|---|---|
| **Separated** | `isSwarmAdmin` is read only on management paths. | `src/features/application-authorization/policy.ts:35-41` |
| **Separated** | A swarm admin is denied a catalog-less app until an explicit grant exists; `@access-admin` carries no business-data rights. | `tests/unit/authorization-policy.spec.ts:107-111`; `docs/security/application-authorization.md:123-131` |
| **Separated** | Protected package handlers run as the caller with `isOperator: false`. | `src/app/composition/application-authorization-runtime.ts:244-245` |
| **Separated** | `service:<app>` never holds `isOperator`; an admin can never activate a user service on someone's behalf. | ADR-157:102-107,181-182 |
| **Separated** | Machine writers get synthetic owners (`alert:prometheus`, `webhook:<provider>`, `a2a:<agentId>`); the operator's sub is explicitly rejected for them, and a class-level spec guards the core entry points. | `src/features/alert-triage/services/alert-triage-constants.ts:44-58`; `tests/unit/machine-write-identity.spec.ts` |
| **Conflated** | Root/admin sessions (`swarm_roles` or the env allowlist) and every valid service-secret request are stamped `is_operator = on` and pass every owner policy. ADR-149 names the fix as its target but has not adopted it. | `src/app/server.ts:767`; ADR-149:59-61,396 |
| **Conflated** | Operator status matches on email, case-insensitively and with no issuer check. | `src/shared/middleware/privileged-identities.ts:63`; `authz.ts:114-121` |
| **Conflated** | `canAccessResource` and `canUseDevice` let an operator use any person's resources and devices. | `authz.ts:145-152`; `device-access.ts:76-90` |
| **Conflated** | "The swarm" has the operator's database power: `SYSTEM_IDENTITY` carries the same privilege. | `request-identity.ts:60-65` |
| **Conflated** | Deployment services use the operator's own identity: install ownership, outbound mail (falls back to the operator's personal Gmail), DLQ alerts, the default model subscription, and the operator automation PAT, which acts as its owner. | `src/features/swarm-apps/services/install-owner.ts:22-27,62-67`; `src/app/routes/notify-routes.ts:276-291`; `src/app/routes/queue-dlq-routes.ts:54-74`; `src/app/routes/free-tier-rotation.ts:648-665`; `scripts/operations/live-proof-runner.js:6`; `cli-token-routes.ts:255-267` |
| **Conflated** | Two admin predicates can disagree: one ignores the issuer, the other checks it. | `authz.ts:114-121`; `src/app/middleware/application-authorization-identity.ts:76-91` |
| **Conflated** | A root or admin account is refused `/api/me` self-deletion. | `exporter-registry.ts:185-188` |

**Decision.** Four distinct things, each an existing mechanism. No new identity system and no "swarm" login.

| Concept | What it is | Mechanism |
|---|---|---|
| Manages the swarm | A role a person holds | `swarm_roles` root/admin (ADR-148) |
| Uses the swarm | The person's own identity | `(sub, issuer)` |
| "The general swarm" as an owner | A **tenant** | `oshal_tenants` plus memberships (ADR-042), using the 060 personal-or-tenant shape without its `is_operator` branch (D3). One tenant is designated the **swarm tenant**. Only its tenant admins change swarm places, devices and rules, enforced in RLS by `oshal_is_tenant_admin` (D3). |
| The swarm's machinery writing | A namespaced non-person subject | `device:<deviceId>` for device-origin writes, minted only from a per-device credential (D3). This is a new namespace in the machine-writer pattern above. Its ingest route lives in core `src/app/routes`, because `machine-write-identity.spec.ts` discovers only core route directories (`:124-129`) and cannot see a store file. |

- **A swarm-owned rule acts as its arming admin.** It runs as the tenant admin who armed it
  (`isOperator: false`). At every fire, the admin's membership, admin role and connection are re-resolved,
  mirroring ADR-157's per-tick recheck. The membership and admin checks are sub-only today (060:83-88;
  `connector-tenancy.ts:421`), so unlike person rows they are not issuer-qualified.
- **Not the ADR-157 service principal.** That principal decides whether a job runs, not what it reads
  (ADR-157 Amendment B). The token broker returns nothing without a user subject
  (`src/app/routes/connector-token-broker.ts:117`), so it could not actuate a household hub. It is also
  per-application, not per-swarm.
- **Not the operator's sub or `runWithSystemIdentity`.** The alert-intake precedent rejects both for machine
  work (`alert-triage-constants.ts:44-51`).

**Recommendation, not a mandate: keep a separate everyday account.** The management account holds root; a
second, ordinary `user` account owns the operator's personal devices, places, rules and location. Why:
(1) everyday sessions stop carrying `is_operator = on` across every other owner-RLS table, because operator
status is decided per identity; (2) the everyday account can erase itself through `/api/me`, which root
cannot; (3) audit separates administrative from personal actions.

**Precondition.** The split holds only if the everyday account's email is on no root/admin `swarm_roles` row
and in no `OSHAL_OPERATOR_EMAILS` entry, and its sub is not in `OSHAL_OPERATOR_SUBS`. Operator status matches
email case-insensitively with no issuer check (`privileged-identities.ts:63`; `authz.ts:117-119`). A second
account on the admin's email, for example a local-auth account on the same Gmail address, would still be
stamped `is_operator = on` and refused `/api/me` deletion.

Costs: the everyday account needs explicit app grants, because staged apps are adopted by the install owner
(`install-owner.ts:6`); `NOTIFY_EMAIL_SENDER_SUB` must be set if the personal Gmail moves to it;
`OSHAL_OPERATOR_EMAILS` keeps naming the admin identity. Sole-operator self-approval is unaffected while the
everyday account is not an admin (`src/app/composition/sole-operator-approval.ts:120-128`). The location
feature does not depend on this split: under D3 and D6 the location tables carry no operator bypass, however
the accounts are arranged.

### D3. The core data model: kernel skill `location`

A new FSD slice, `src/features/location`, is registered as kernel skill `location` in `KERNEL_SKILLS`, with
its build-anchor re-export and a doc row. Packages reach it through `uses: location`. The shared geo math
(`GeoPoint`, `haversineM`, metres-per-degree) moves to `src/shared/utils/geo.ts`, so the slice does not
import the drone slice. The existing drone copies are left as they are. Storage is plain `DOUBLE PRECISION`
lat/lon with haversine, the career-corpus shape; PostGIS would be an image change and is not needed at
household scale.

Every table that can hold a person's data carries `owner_sub` + `principal_issuer`, which are NULL on tenant
rows. That is what `/api/me` export and delete discover (D6).

| Table | Holds |
|---|---|
| `location_settings` | One row per person: default precision class and retention per class, bounded by DB CHECKs. |
| `location_devices` | One row per located device (`device_kind`, `device_ref`): the owner of its location data (`owner_sub`+`principal_issuer`, or `tenant_id`), an optional `carried_by_sub` (only when the owner is that person), an assigned `place_id` and room, `reporting_enabled` (default false), `precision_class`, `last_seen_at`. No control right (D1). |
| `location_observations` | Fixes, insert-only for writers: owner columns (the carrying person, or the device's owner or tenant), `subject_ref`, source (`browser`, `mavlink`, `manual`, `hub`), minimised lat/lon, optional alt, `accuracy_m`, `observed_at` (client-reported), `received_at` (server), `expires_at` (set by trigger). |
| `location_current` | One row per subject, upserted on ingest: owner columns, the latest minimised fix, the current place, `expires_at`. Reads report its age. |
| `location_places` | Named places owned by a person or a tenant: `name`, `label` (home, work, grocery, other), a circle (centre plus `radius_m`), an optional owner-typed `address`, an optional `timezone`, `created_by_sub`. |
| `location_map_anchors` | A spatial map's geodetic anchor, **by reference**: `map_kind` (`spatial-scan`, later `embodied-scene`), `map_ref`, origin lat/lon/alt, heading, footprint radius, accuracy, anchor source, capturing device and time, an optional `place_id`, and the map's owner (person or tenant). No geometry is copied into core. |
| `location_shares` | A person's grant of their `place-transitions` to a tenant: owner columns (the grantor), `tenant_id`, the explicit set of tenant place ids the grantor approved, the approval's geometry digest, expiry, revocation. |
| `location_member_restrictions` | `(tenant_id, user_sub)` rows a tenant admin sets. They mark an account whose location may not be collected or shared (D6). |
| `location_rules`, `location_rule_state`, `location_rule_fires` | The proximity rules of D4; the per-(rule, subject) enter/exit state; and the fire ledger (`UNIQUE(rule_id, subject_ref, transition_id)`). State and fire rows carry owner columns for the **subject** (the person, or the subject device's owner or tenant), plus `expires_at`, so a subject's presence rows are theirs to export and erase. |

**Kernel skill operations.** This is the package-facing contract. Removing an operation later breaks every
installed package (`src/shared/kernel-skills/registry.ts:71-73`), so v1 ships only these:

| Operation | Caller | Input | Output | Coordinates or address? | Slice |
|---|---|---|---|---|---|
| `currentPlace` | Package route as the caller; Jarvis | A subject the caller may read | Place id, label, name, since, age | No (model-safe) | L4 |
| `distanceBand` | Same | Subject, place id | `at`, `<1 km`, `<10 km`, `farther`, `unknown` | No (model-safe) | L4 |
| `placeAt` | Package route | A caller-supplied point | The caller-visible places containing it (id, label, name) | No | L4 |
| `operationAddress` | Package server code only | Place id | The owner-typed address and the centre | **Yes, operation-only.** It may be passed only into a fixed-server provider operation or the owner's own page, never into a prompt. | L4 |
| `mapsNear` | Drone and spaces package routes | A caller-supplied point, radius | Map refs (kind, ref, captured at, place id if any), newest first | No | L7 |
| `anchorMap` | Spaces and drone package routes | Map ref, geodetic anchor, footprint | Anchor id | Stores coordinates; returns none | L7 |
| Device-action handler | Home package | Registered through the existing `package-tools` kernel skill (`PackageToolContext.register(name, handler)`; the evaluator invokes `executePackageTool(name, input, actorSub)`, which runs under the exact caller, `src/shared/package-tools/index.ts:18,174`) | Outcome | Input is `{ruleId, fireId, device, operation}`, no coordinates. Whether the evaluator needs its own caller policy beside Jarvis's is settled in L8. | L8 |

**Row-level security.** Every table is ENABLE + FORCE RLS, and **no policy has an `oshal.is_operator`
branch**. Policies are written by hand: the stock `buildOwnerRlsPolicyStatements` adds that branch, and so
does the 060 personal-or-tenant policy, whose shape is reused here without it.

- **Person rows** match `owner_sub` and `principal_issuer` against the request GUCs, the issuer-qualified
  shape of migration 145.
- **Tenant rows** (`tenant_id` set, `owner_sub` NULL): SELECT for `oshal_is_tenant_member`; INSERT, UPDATE and
  DELETE only through a new SECURITY DEFINER `oshal_is_tenant_admin(tenant)` in `USING` and `WITH CHECK`. A
  non-admin member cannot move a tenant geofence, subject or action. Both helpers are sub-only (060:83-88).
- **The membership fence.** A BEFORE INSERT and BEFORE UPDATE OF `tenant_id, user_sub, role` trigger on
  `oshal_tenant_memberships` requires the writer to be an existing admin of the target tenant, regardless of
  `is_operator`. The creator is allowed only for a tenant's first row. Both core writers already satisfy this
  (`connector-tenancy.ts:445` creates the tenant with its creator as admin; `:458` runs after the app admin
  check). Self-service `display_name` updates (`src/app/routes/privacy-routes.ts:338`;
  `src/features/speaker-diarization/speaker-profile-store.ts:605`) do not fire it. Members who share
  presence with the tenant are notified when membership changes. This is the one change this ADR makes
  outside the `location_*` tables.
- **Rule and place integrity.** Foreign-key checks bypass RLS, so a SECURITY DEFINER predicate backs the rules
  table's `WITH CHECK`. The referenced place must be owned by the rule's owner, or be tenant-owned with the
  rule owner a member. A `device` subject must be a device the rule's owner owns; a device owned by another
  person is refused.
- **Subjects read what names them.** A SELECT-only policy lets a subject read the rules that name it
  (`subject_ref = current_sub`), and the places those rules reference only where the place's owner is the
  rule's owner.
- **Subjects write evaluation state.** A narrow INSERT/UPDATE policy on `location_rule_state`, and an INSERT
  policy on `location_rule_fires`, admit rows where `subject_ref = current_sub` and a SECURITY DEFINER
  predicate confirms that the rule is active. For a tenant rule naming a member, the predicate also confirms
  an accepted share whose place set contains the rule's place. There is no DELETE policy for subjects.
- **Devices.** A `device:<id>` subject may INSERT observations whose owner columns match what
  `location_devices` records for it (a SECURITY DEFINER predicate). It may read that owner's places and the
  rules naming the device, and write evaluation state as a subject. It reads no observations.
- **Tenant grantees read a projection.** No grantee policy exists on the base tables. Members read a member's
  shared transitions only through a SECURITY DEFINER function that returns the granted granularity for the
  approved places, and never coordinates.
- **Dispatch identity.** After commit, the evaluator switches identity in-process for each claimed fire row,
  to the rule's actor with `runWithRequestIdentity({sub, principalIssuer, isOperator: false})`. The
  precedent is `src/app/home-schedule-dispatch.ts:84`.
- **Crash recovery.** A sweep runs under its own broker GUC, `oshal.location_dispatch_broker`. Its `USING`
  admits only fire rows that are claimed and not yet dispatched, and it dispatches each under its actor as
  above. It is neither SYSTEM nor `is_operator`.
- **Retention purge.** A `FOR ALL` policy (the shape of `scripts/migrations/117-swarm-memory-provenance.sql:66-69`)
  under `oshal.location_purge_broker`, `USING (expires_at < now())`. A DELETE-only policy would delete
  nothing, because a DELETE whose WHERE reads columns must also pass a SELECT policy.
- **`SYSTEM_IDENTITY` is denied**, because it has a blank sub and the operator branch is gone.
- **A static guard** fails if any `location_*` policy text contains `oshal.is_operator`.

**Ingest and machine identity.**

- **The service-secret rail is refused.** No `/api/location/*` route uses `serviceSecretOr` or
  `requireTrustedServiceUserIdentity`. That covers ingest, rules, shares and arming. A request that
  authenticates only with the service secret gets 401, because that rail can speak as any user
  (`authz.ts:210-222`) and arrives operator-stamped (`server.ts:767`). Location routes run their queries
  with `isOperator: false`.
- **Browser ingest** posts to `/api/location/presence` as the signed-in person. The owner is always derived
  from the session, never from the body.
- **Device ingest** is a core route, `POST /api/location/devices/:deviceId/presence` in `src/app/routes`. It
  accepts only a node-bound token (migration 102, minted through `/api/join/enroll`) whose `node_client_id`
  equals the device's `device_ref`. `decideNodeTokenScope`
  (`src/features/remote-client/services/node-token-scope.ts:97`) gains that one path for the bound id, with the
  same foreign-device refusal. The route derives `device:<id>` from the verified binding, never from the
  body. Before it writes, it replaces the request's stamp, because a node token authenticates as its minting
  user and may be operator-stamped, with `runWithRequestIdentity({sub: 'device:<id>', isOperator: false})`.
  Its credential check joins `MACHINE_AUTH_MARKERS` and it gets an inventory entry, so
  `machine-write-identity.spec.ts` discovers it.
- **A device that can only authenticate with a shared secret** cannot report location and cannot be the
  subject of any rule.

**Precision minimisation.** Each device reports at a precision class its owner chooses. Evaluation (D4) runs
on the full-precision fix in memory, before minimisation. Only what is persisted is rounded, and rule state
holds timestamps and counts, not coordinates.

| Class | Stored | Use |
|---|---|---|
| `exact` | 5 decimals, about 1 m | Drone telemetry; a person who chooses it |
| `block` | 3 decimals, about 110 m | The default for people |
| `city` | 2 decimals, about 1 km | Weather, delivery-area checks |
| `place-only` | No coordinates | Only the transition is persisted |

**Retention** (proposed defaults, Q4), each a per-owner setting in `location_settings` bounded by a DB CHECK
(the ambient-listening precedent): raw person fixes 7 days (1–90); transitions 30 days (1–365); swarm-device
tracks 30 days (1–365).

- A BEFORE INSERT trigger sets `expires_at` from `received_at` plus the owner's setting, ignores any client
  value, and a CHECK caps it at the class maximum.
- `location_current` and `location_rule_state` expire from their last update under the raw-fix setting, so a
  device that stops reporting without opting out does not keep its last fix.
- Fire-ledger rows, including their evidence provenance (D4), expire with the subject's transitions retention.
- Places, rules and shares are kept until deleted. Opt-out clears `location_current` and purges that device's
  observations. The purge starts after a jittered delay following boot.

**Map anchors: "where it mapped".** A map is found by its own anchor, not only by a saved place.
`anchorMap` records a scan's geodetic anchor and footprint when it is captured, whether or not the capture is
inside a saved place. `mapsNear(point, R)` returns the maps whose anchor lies within R plus footprint of the
point, newest first. A place is an optional grouping on the anchor row. The anchor grants nothing: the scan's
own RLS still decides who may open it. Three limits of today's code are stated rather than solved:

- **Tenant scans.** A tenant-owned anchor can reference only a tenant-owned scan, and
  `spatial_scans.user_sub` is NOT NULL today. A nullable `tenant_id` using the 060 shape without its operator
  branch is an explicit ADR-111 amendment (slice L7).
- **Room-level matching.** Indoor GPS is ±5–20 m (`capture-telemetry.ts:21`), so room-level matching needs
  relocalization against the stored map. Embodied has a simulated voxel-map `relocalize`
  (`store/embodied/src-routes/engine/sense/register.ts:291`); ADR-111 scan and drone relocalization is not
  built (ADR-111:7). This ADR provides the lookup, not the relocalization.
- **Capture GPS.** It must be joined to the scan it produced; today it is keyed only by session.

**No location in logs, paths, models or egress:**

- **Logs.** The redaction list matches top-level keys and one-level `*.` wildcards only
  (`src/shared/logger/logger.ts:15-19`), so it cannot reach `telemetry.position.lat` or a coordinate inside
  an error string. It gains only namespaced keys (`location`, `*.location`, `coords`, `*.coords`). Generic
  words like `accuracy`, `address` and `position` are not added platform-wide: other slices log them with
  unrelated meanings (for example `token-chase-optimize-service.ts:455` logs `accuracy`). The control is a
  static guard over `src/features/location` and the location routes. Logger calls there may pass only
  allowlisted id and count fields, never a fix, place, telemetry or error-with-URL object.
- **Paths.** URL paths carry ids only, never coordinates or place names, because audit capture writes paths
  to the append-only `access_audit_log`. It stores the first UUID segment as `resource_id`
  (`src/features/governance/audit/audit-capture-middleware.ts:77-81`), and admins can read that log
  (`docs/governance/rls-policies-enforce.sql:58-62`). An id alone reveals nothing without its row, which has
  no bypass. Both ingest paths end in `/presence`, which audit capture already skips (`:39`).
- **Routes and step-up.** All `/api/location/*` routes are behind `requiresAuth` and are guest Tier C. A
  packaged surface's script can call them as the person (Context rule 5). The routes that change consent or
  actuation therefore require a fresh authentication proof that same-origin script cannot supply: OIDC
  re-auth with `max_age` and a checked `auth_time`, or local-auth TOTP. Those routes are opt-in, precision
  raise, accepting a share, arming act-on-arrival and extending retention. Core has none of this today; L3
  builds it, and `MOCK_OIDC` must be able to issue a fresh `auth_time` so it works on `localhost`. Owner
  coordinate reads need the same proof, valid for a short window. Within that window a same-origin package
  script can read what the Settings page can; the window bounds that exposure. Packages get labels only,
  through the kernel skill, on the server.
- **Models.** The model-safe reads (`currentPlace`, `distanceBand`) return a place label and name, a distance
  band and "since", never coordinates, addresses or trails. `operationAddress` never reaches a prompt (D5).
  The DLP redactor has no coordinate detector, so it is no backstop.
- **Geocoding: none in v1.** Places are created from the current fix ("here") or typed coordinates, and the
  address is text the owner types onto the place row. The rides script geocoder is not adopted: it defaults to
  public Nominatim, sends raw coordinates, and keeps results in a shared file outside RLS, retention and
  erasure (`scripts/oshal-uber-rides.js:170,398-410,543-557`). A later kernel geocoder must have no public
  default, geocode only stored values no finer than `block`, keep forward results on the place row, and never
  persist reverse lookups.

### D4. Proximity rules: reminders and triggers

```yaml
owner:     { person: <sub> } | { tenant: <tenantId> }
armedBy:   <sub, issuer>        # the person, or a tenant admin; never on someone else's behalf
subject:   { person: <the arming person> } | { device: <deviceId owned by the rule owner> }
         | { anyMemberOf: <tenantId> }       # tenant rules only
place:     <placeId>            # a circle
on:        enter | exit
repeat:    once | every-visit   # "next time I'm at …" defaults to once
cooldownSec: 900
action:    { kind: remind | notify | workflow | device-action, … }
armDigest: <hash>               # device-action and tenant rules; see gate 4
```

A tenant rule evaluates a member only while that member holds an accepted share whose approved place set
contains the rule's place (D6).

**Evaluation is event-driven, on the controller, as the subject.** When a fix arrives, the ingest request, in
the subject's own identity, evaluates the full-precision fix in memory against the places the subject can
see (their own, their tenants', and those of rules naming them). It then writes the minimised observation,
reads the rules that name the subject, updates `location_rule_state` and claims fire-ledger rows, each under
the D3 policies. It acknowledges only after commit (ADR-125 durable-before-ack). Actions are dispatched
afterwards from the claimed ledger rows under the rule's actor (D3 dispatch identity), so a slow connector
never blocks ingest. Nothing in the path runs as SYSTEM.

**Why not the cron scheduler.** `ScheduleRecord` requires a cron, the runner is off unless
`ENABLE_AGENT_SCHEDULER=true` (`src/app/schedule-runtime.ts:139-151`), and polling cannot hold enter/exit
state.

**Why the controller and not the edge.** Rules can belong to tenants, so consent revocation, arming, cooldown
and audit need one authority, and ADR-122 puts authority in deterministic server code. A node may sit behind
NAT (ADR-140 D6) and must not decide someone else's rule. The edge keeps a role: a future native phone node
may evaluate OS geofences locally and post transitions instead of fixes, which saves battery and keeps raw
tracks on the phone, but those transitions are evidence the controller still decides on.

**Hysteresis, debounce, confidence** (proposed defaults, tunable per rule within bounds). All timing uses the
server's `received_at`. The client-reported `observed_at` never qualifies a fix or makes it fresh.

- A fix qualifies only if `accuracy_m` is within the rule's floor (default 50 m) and it was received at most
  120 s before evaluation.
- **Enter:** two qualifying fixes inside the circle, received at least 30 s apart.
- **Exit:** confidently outside (`distance − accuracy > radius + margin`, margin = max(50 m, 25 % of radius))
  for 3 minutes. Trigger radius is at least 50 m; the default is 100 m for a person's places and 150 m for
  tenant places (D6).
- **Cooldown** per (rule, subject) survives flapping; state is durable, so a restart never re-fires. A
  transition whose triggering fix was received more than 5 minutes before evaluation never triggers a
  physical action.

**Outside the location tables, a fire leaves ids only.** Any record a fire writes outside `location_*`
carries only `rule_id`, `fire_id` and the outcome. It carries no place name, no subject and no reminder or
"arrived at" text. Those tables keep the operator bypass: `jarvis_tasks`
(`scripts/migrations/100-jarvis-tasks-base-schema.sql:41-44`; 060:112), `tickets`
(`docs/governance/rls-policies-enforce.sql:22-31`) and `connector_action_audit`
(`scripts/migrations/112-owner-column-rls.sql:100,127-132`). `connector_action_audit` is also append-only
(`083-connector-action-audit.sql:37-45`) and kept on `/api/me` erasure (`discovered-exporters.ts:36-45`). The
readable detail lives in `location_rule_fires` and is resolved at read time under the person's identity. The
existing home-schedule ticket, which stores the label, the full prompt and `firedAt`
(`home-schedule-dispatch.ts:95-100`), is not the model for a location fire.

**Action routing**, with each target an existing rail:

- **`remind` / `notify`.** Delivered on the two rails the trading-event reminders use: a Jarvis shelf row
  (ids only; its text is resolved from the fire row when opened) plus `NotificationRouter.notify(actor,
  'location', text)` (`src/app/trading-event-alerts.ts:4-10`). The notifier first asks the chosen channel's
  `tier(userSub)` (`notify-routes.ts:92-97`). On a `deployment`-tier channel, the message body is generic:
  "You have a location reminder — open oshal". This covers SMS on the deployment's Twilio, voice, and
  Telegram on the deployment bot token (`notify-routes.ts:148-151,185,218-224`). Full text goes only on
  `own`-tier channels or in-app. The idempotent ledger follows the trading precedent, and a per-person daily
  cap follows Haven (ADR-079). It is deliberately **not** `jarvis-reminder`. There is no web push channel
  today.
- **`workflow`.** Creates an owner-stamped `workflow:<ticketType>` ticket
  (`src/app/workflow-ticket-schedule-dispatch.ts:30-66`) that carries the rule and fire ids only. Approval
  gates still park it.
- **`device-action`.** Physical actuation, such as opening the garage. It passes every gate below, each
  anchored in an existing rule:
  1. **A deterministic server operation with a closed allowlist.** The home package registers the handler
     through `package-tools` (D3). The handler declares a closed allowlist of (capability, command) entries,
     each tagged risk-reducing or risk-increasing. Anything unlisted is risk-increasing, and the free-form
     `set` is never reachable from a rule. Today's working device-write path is home `/control`, which
     returns 428 without `confirm` and accepts only switch on/off plus a free-form `set`
     (`store/home/src-routes/home-routes.ts:314-336`). The bot tool carrier is disabled
     (`any-bot/server/services/tools/brokered-cli-runner.js:38-47`). A location fire never reaches
     `executeBotOrInline` or the prompt-driven home schedule path (`home-schedule-dispatch.ts:5-6,88`). v1
     arms one exact operation on one exact device. Arming a saved scene (`/scene/run`, `home-routes.ts:340`)
     by its frozen step list is deferred (D7).
  2. **Explicit per-rule arming.** The arming confirmation names the exact device and exact operation (the
     ADR-140 D5 pre-authorization shape). Only the actor can arm, and only with the step-up proof (D3). There
     are two modes. **Ask on arrival** is the default: the transition sends a notification linking to the home
     confirm card, which calls the handler with `confirm: true`. **Act on arrival** needs Q3 *and* an
     independent presence signal besides the browser fix, such as a hub presence sensor or a native-node
     attested transition. Risk-increasing operations never act on browser fixes alone. v1 builds neither
     signal source (SmartThings presence is not read, and there is no phone node), so in v1 act on arrival
     falls back to ask on arrival.
  3. **Presence confidence floor.** The qualification rules above apply, with no late events.
  4. **Recheck at every fire.** The actor must still hold the connection, personal or household (ADR-042),
     and for a tenant rule must still be a tenant admin. The rule must still be armed and the device must
     still exist. Arming stores `armDigest`, a digest of (rule, place geometry, subject, device, operation),
     and every fire re-verifies it, so any edit by anyone disarms the rule.
  5. **Audit.** Each fire writes a fire-ledger row with its evidence provenance (`device_ref`, source, auth
     mode, `accuracy_m`, `received_at`, no coordinates), kept as long as the fire row. It also writes
     `connector_action_audit` with a params hash (ADR-105), carrying ids only. There is no per-fire ticket.
  6. **Bounded direction, failure closed.** Risk-increasing entries fire only on `enter`. `exit` may fire only
     entries the handler tags risk-reducing, and only those entries are exempt from confirmation (the drone
     fleet-abort precedent, `src/features/drone/services/drone-service.ts:268-273`). A failed gate means no
     action plus a notification of the reason. A rule whose subject's feed has gone silent shows "not watching
     since …" (the ADR-125 absence alarm).

### D5. Consumers stay in the store (Rule 0c)

Core ships the kernel skill, its storage, the evaluator, the device ingest route, the Jarvis intent that turns
"next time I'm at X" into a rule (Jarvis reminders are core), and the consent/places/devices/rules UI as a
cockpit **Settings → Location** tab. It is not an eleventh `swarm-apps` manifest.

| Package | Would call | Replaces |
|---|---|---|
| eats | `currentPlace` for the label; `operationAddress` only inside the deterministic proposal and hand-off operation. The concierge prompt says "deliver to: Home (on file)". Today the prompt carries the address (`store/eats/src-routes/eats-routes.ts:301,315`, sent at `:495-499`). Search takes no location today (`:387,485`). | The `default_address` text string |
| rides | The owner page's current position for the pickup pin; home and work as labels in the prompt, with addresses passed only to the provider operation. Today the prompt carries both addresses (`store/rides/src-routes/rides-routes.ts:203`, sent at `:406-413`). | Its `home_address` and `work_address` TEXT. Its own script geocoder stays in the store (D3). |
| purchasing | Places labelled as stores | The `preferred_store` text string |
| home | The `device-action` handler (D4 gate 1), which a place transition calls directly. The prompt-driven home schedule is not a trigger target. Hub place assignment; solar lat/lng from the home place at `city` precision. | Per-schedule browser coordinates in `taskData` |
| drone | `mapsNear` at mission planning. Registration, telemetry ingest and fleet-route scoping are core slice L6 work. | Nothing in v1. The env-configured sim home point (`drone-service.ts:45,106-107`) stays; MAVLink drones already report home from the flight controller. |
| spaces | `anchorMap` on capture; an optional `placeId`; capture GPS joined to the scan | Session-keyed GPS |
| embodied | Load a scene by anchor reference (still simulated in memory) | Nothing new persisted |

### D6. Privacy and consent

**Off by default.** Location is opt-in per person, and each device reports only after its owner enables it and
picks a precision class (the browser adds its own prompt). Opting out stops ingest, clears `location_current`
and purges that device's observations.

| Viewer | What they can see of a person's location |
|---|---|
| The person | Everything that is theirs. Coordinate reads need the step-up proof (D3). |
| Another person | Nothing in v1. Person-to-person shares are deferred (D7). |
| Tenant members | Tenant places, tenant rules and tenant-device positions. A member's place transitions only for the places that member approved in an accepted share, through the projection function. Only tenant admins change tenant rows. |
| Swarm root/admin | Nothing personal by virtue of the role. The remote-client node list shows online state and last seen, and carries no position. The drone package's `/state`, `/fleet` and `/fleet/:id/state` return live position and home to any authenticated caller today (`drone-types.ts:127-128`; `drone-fleet.ts:32`; `store/drone/src-routes/drone-routes.ts:288-293,378,387,511`); L6 tenant-scopes them. The records a fire leaves outside the location tables carry ids only, so an admin can see that a fire happened and when, but not where or what. The exception is `connector_action_audit`, which names the actor, operation and time of every device action and is kept forever; the consent screen says so. Admins see tenant data as members. This adopts ADR-149's recommended "no automatic business-record access" (ADR-149:59-61,396) for the location tables only; it does not decide the platform-wide question. There is no break-glass read. The administrative remedies are to revoke a device or remove a member. |
| Background / SYSTEM | Nothing, except the purge and the dispatch-recovery sweep, each under its own broker GUC. |
| Models | Place labels, names and distance bands only. |

- **Tenant shares name their places.** A person shares `place-transitions` with a tenant by approving an
  explicit set of tenant place ids, capped at 20. A tenant rule evaluates that member only at a place in the
  set. Adding a place, or changing an approved place's geometry, needs re-acceptance. A tenant place used for
  a member must have a radius no finer than that member's precision class (`block` 110 m, `city` 1.1 km), so a
  tenant cannot rebuild a track finer than the member chose; tenant places default to a 150 m radius for
  that reason. The member can list every tenant rule that
  names them (owner, place, kind, action class) and revoke. Revocation stops evaluation and deletes the share
  and the derived state.
- **Minors.** Core has no account-level minor attribute (Context). v1's enforcement input is
  `location_member_restrictions`: a tenant admin marks an account, for example at invite. While a row names
  an account, that account cannot opt in a carried device or accept a share, and no rule may name it. An
  account outside every tenant has only its own, owner-only data. Allowing it with guardian consent is Q5,
  deferred.
- **Deletion and takeout.** Every person-bearing table carries `owner_sub`, so `/api/me` export and delete
  discover it (`src/features/data-lifecycle/services/discovered-exporters.ts:31,176,182`). For rule state and
  fires, the owner is the **subject**, so a member's presence rows under a tenant rule are exported and erased
  with that member. Tenant rows keep `owner_sub` NULL plus `created_by_sub`, because the discovered delete
  ignores `tenant_id` (`:182`), so a creator's erasure does not delete household places. The
  hand-enumerated `DELETE /api/privacy/me` (`src/app/routes/privacy-routes.ts:62-86`) is extended to stop
  ingest and clear the evaluator's in-memory state for the caller.
- **Audit.** Consent, shares, arming and every device-action fire are audited as D4 describes. Ingest is
  not audited per fix; the retention-bounded observation table is the record, and a fire's evidence
  provenance traces it to the device, source and auth mode that caused it.
- **Fixtures.** Tests use synthetic coordinates and never real addresses. Map screenshots stay out of the
  tree except in curated directories, as the publish gate requires.

### D7. Not decided or built here

- **No phone node.** The native phone app (ADR-044 Phase 2/4) gets its own decision.
- **No person-to-person sharing**, and no `coarse-position` granularity. No polygons, time windows, `dwell`
  or `until:<date>`. These were not requested; each is a follow-up if asked for.
- **No scene arming** and **no kernel geocoder** in v1 (D3, D4).
- **No node heartbeat fix.** A node has an assigned place only. The heartbeat field arrives with a node that
  can sense a position, and then only under a node-bound token for its own clientId. It is dropped in the
  shared-secret auth mode and for any session caller who is not the owner
  (`src/app/routes/remote-client-routes.ts:235,288-321,334-341`).
- **No change to ADR-114 or `canUseDevice`** (D1).
- **No other platform-wide change.** The operator bypass on other tables and ADR-149's platform-wide admin
  policy are unchanged. The membership trigger (D3) is the only change outside the location tables.
- **No category places.** "Any grocery store" needs a POI source. In v1, "the grocery store" resolves to the
  person's saved places with that label; with none, Jarvis offers to save "here" (L5).
- **No web push and no PostGIS**, and drone geo math is not refactored.

## Consequences

**Gained.**

- One consented, owner-scoped location and places store replaces five per-package copies.
- Reminders and triggers fire on place, not only on time, over the existing delivery, workflow and
  device-write rails. A drone's maps can be looked up by position, whether or not the capture was in a saved
  place.
- "The general swarm" becomes a tenant with named admins instead of the operator's personal subject.
- For location, "administers the swarm" and "reads a member's rows" are separated by policy and a guard. That
  is the ADR-149 target, met for one person-owned data class.

**Costs and risks.**

- Removing the bypass means an admin cannot debug another person's location rows; their tools are health and
  counts.
- Browser location stops when the page closes, so arrival rules fire only while the cockpit is open until the
  native phone node or a hub presence source exists. For the same reason, act on arrival stays ask on arrival
  in v1.
- The membership trigger touches a load-bearing core table used by every tenant. Its RLS proof covers both
  existing writers. Fixtures that insert memberships directly must set an admin identity.
- The step-up mechanism is new core authentication code and needs its own proof under `MOCK_OIDC` and real OIDC.
- The ADR-111 amendment (tenant-owned scans) touches load-bearing core and needs its own RLS proof.
- A tenant rule acts as its arming admin, so it stops when that person leaves the tenant or loses the
  connection. That is correct, but someone must re-arm it. Any edit also disarms it.
- Records outside the location tables carry ids only, so the Jarvis shelf and workflow tickets show less text
  than other features do until they are opened.

## Alternatives considered

1. **Keep location per package.** Rejected: five uncoordinated copies, no triggers, no consent model.
2. **Location as a store package.** Rejected by the kernel-skill test: two or more apps need it, and it needs
   core tables, a core machine-ingest route and the Jarvis intent. The consumers stay in the store.
3. **A "swarm" login account that owns swarm devices.** Rejected: a shared credential no person holds, which
   would carry the bypass if made admin and duplicate the tenant primitive.
4. **The ADR-157 service principal as the swarm owner.** Rejected for ownership: not a data fence (Amendment
   B), cannot broker a connector token, per-application. It stays the principal for package jobs that act
   as the application.
5. **The stock owner policy with the operator bypass, disclosed.** Not the default, because every admin
   session would see every member's location. It remains the Q2 alternative.
6. **Polling through the cron scheduler.** Rejected: schedules require a cron, and polling cannot hold
   enter/exit state.
7. **Authority at the edge.** Rejected as authority; accepted later as an evidence source.
8. **The personal graph's `Place` as source of truth.** Rejected: off by default and in memory. A graph
   `Place` may point at a place id later.
9. **PostGIS.** Deferred: an image change that household scale does not need.
10. **A tenant branch in `canUseDevice` for swarm-owned nodes.** Rejected here: that gate decides who may run
    full-access work on a person's computer, not who may see where it is (D1). Tenant-usable nodes need their
    own ADR.
11. **Drone ingest in the store drone package.** Rejected: the machine-write spec cannot discover a store
    route, and the drone heartbeat names its drone in the body under a shared secret.

## Open questions for the operator

- **Q1: the swarm tenant (before L6).** Should there be a dedicated tenant (`kind = 'swarm'`, at most one by
  partial unique index, mirroring the single-root index), or should the household `space` tenant serve as the
  swarm tenant? On a single-family box they can be the same row.
- **Q2: admin visibility (before L2).** Should the location tables have no operator bypass (recommended), or
  keep the bypass with a disclosure on every consent screen?
- **Q3: garage pre-authorization (before act-on-arrival within L8).** This is ADR-140 operator item 4
  (140:233-234). May a person pre-authorize "act on arrival" for an exact operation on an exact device, or
  must every opening be confirmed on arrival? Even if yes, act on arrival also needs an independent presence
  source (D4 gate 2).
- **Q4: retention (before L2).** Ratify or amend the D3 defaults.
- **Q5: minors with guardian consent (deferred).** v1 blocks location for restricted accounts (D6). Allowing
  it with guardian consent is a later decision.
- **Q6: account split.** Adopt the separate everyday account (D2 recommendation)? It is independent of this
  feature.
- **Q7: phone node (before L8 live acceptance).** Commit to the native phone node for background presence, or
  accept foreground-only arrival detection?

## Rollout (slices with done-when)

Each slice is its own PR, ships its behaviour tests plus Test Lab registration, and keeps "locally tested"
separate from "live-proven". A slice starts only after the questions its Status gate names are answered.

- **L1: Shared geo and log guard.** `src/shared/utils/geo.ts`; the namespaced redaction keys; the static
  log guard over `src/features/location` and the location routes. Done when the guard's spec goes red on a
  planted logger call that passes a depth-3 telemetry object (`telemetry.position.lat`) or an error carrying a
  URL, and typecheck passes on the committed tree.
- **L2: Storage and RLS (after Q2, Q4).** Migrations for `location_settings`, `location_devices`,
  `location_observations`, `location_current`, `location_places`, `location_shares` and
  `location_member_restrictions`, with the no-bypass policies, `oshal_is_tenant_admin`, the membership
  trigger, the expiry trigger and the purge GUC; the kernel-skill registry entry and doc row; guest Tier C.
  Done when a live two-role RLS spec against the enforcing role proves all of the following:
  - an owner reads their rows and a stranger reads nothing;
  - a tenant member reads tenant rows but cannot write them;
  - an admin session reads no other person's rows;
  - an admin or operator-stamped session cannot add itself to a tenant and then read that tenant's rows,
    while both existing membership writers still succeed;
  - SYSTEM is denied;
  - the purge removes expired rows (counted before and after) and keeps unexpired ones;
  - a client-supplied `expires_at` is ignored;
  - `/api/me/delete-confirm` removes the person's observations and current row.

  Also: the static no-`is_operator` guard goes red on a planted bypass, and `rls-core-table-coverage-live`
  passes.
- **L3: Browser ingest, consent and step-up.** `/api/location/presence`, the step-up proof, and the Settings
  Location tab (per-device opt-in, precision, retention, "who can see me"). Done when a human on `localhost`
  with `MOCK_OIDC` can opt a browser in, see their current place, opt out and see the rows purged. Specs prove
  that a body-supplied owner is ignored, that a service-secret request is refused, and that a fetch from a
  packaged surface without a fresh proof cannot opt in, raise precision, accept a share or arm a rule.
- **L4: Places and device enrolment.** Circle places, tenant places, `placeAt`, `currentPlace`,
  `distanceBand` and `operationAddress`. Enrolling an existing node, camera, TV or hub as a `location_devices`
  row, and setting or clearing its assigned place and room, all in the Settings Location tab. Done when specs
  cover containment edges and ownership refusals; a node, a camera and a TV each show an assigned place that
  the owner can change and a non-owner cannot; and a non-admin cannot enrol a drone or camera to the swarm
  tenant.
- **L5: Reminders.** The rules, state and fire tables with their subject, dispatch-recovery and projection
  paths; the evaluator; two-rail delivery with tier-aware text; tenant shares with place sets; subject
  visibility; the Jarvis "next time I'm at X" intent, including "here" and "this store", which proposes a new
  place at the current fix (confirm name, label, radius). Done when:
  - a scripted fix sequence proves edge jitter does not double-fire, exit hysteresis holds, and cooldown,
    `once` versus `every-visit` and stale fixes behave as specified;
  - a back-dated `observed_at` does not qualify a fix;
  - a 100 m place fires correctly for a person stored at `block`;
  - a member is never evaluated for a place outside their approved set; a set above the cap, a foreign place
    id and a foreign device subject are each refused;
  - a scripted "I'm at the grocery store, remind me next time" creates the place and the rule, and the rule
    fires on the next visit;
  - after another person's fire, an admin session reading `tickets` and `jarvis_tasks` finds no place,
    subject or reminder text, and a `deployment`-tier message carries only the generic text;
  - after member B is erased, the tenant's rule tables hold no row naming B;
  - a Test Lab scenario passes.
- **L6: Swarm ownership and drone ingest (after Q1).** The swarm tenant; the core device ingest route under a
  node-bound token, its `decideNodeTokenScope` path and its `MACHINE_AUTH_MARKERS` entry; the drone node
  posting fixes; and a store drone PR that tenant-scopes `/state`, `/fleet` and `/fleet/:id/state`, or strips
  position for non-members. `canUseDevice` and `remote_task_journal_client_owners` are untouched. Done when
  `machine-write-identity.spec.ts` discovers and covers the ingest route; a device id that differs from the
  token binding is refused; a service-secret request is refused; and a non-member gets no position from the
  location reads or from the three drone routes.
- **L7: Map anchors.** `location_map_anchors`, `anchorMap`, `mapsNear`, capture GPS joined to its scan, and
  `tenant_id` on `spatial_scans` (ADR-111 amendment). Done when a scan captured inside place P and a scan
  captured outside every saved place are both returned by `mapsNear` on a later visit, and a non-member cannot
  open them.
- **L8: Device-action triggers (Q3 before act on arrival; Q7 before live acceptance).** The home package
  handler with its closed allowlist, registered through `package-tools`; ask on arrival; act on arrival only
  with Q3 and an independent presence source. Done when:
  - specs prove no fire below the confidence floor, when unarmed, after the connection is revoked, after any
    edit changes the arm digest, on a late event, on a browser-only fix for a risk-increasing act-on-arrival,
    for an unlisted or `set` command, or for a risk-increasing entry on exit;
  - a location fire never reaches `executeBotOrInline`;
  - each fire writes one fire-ledger row with its evidence provenance;
  - risk-reducing entries are exempt from confirmation;
  - an admin session finds no place, subject or reminder text in `tickets`, `jarvis_tasks` or
    `connector_action_audit` beyond the disclosed audit row.

  Live acceptance on a real hub is the operator's external step.
- **Store PRs**, each after its core dependency lands:
  - **eats:** proposal prefill from the home place. Done when a store spec proves `buildConciergePrompt`
    never contains a value returned by `operationAddress`, and the prompt names the place by label.
  - **rides:** home and work from places. Done by the same prompt spec for its prompt builder.
  - **purchasing:** store-labelled places. Done when the preferred-store prefill reads a store place.
  - **home:** the place trigger through the device-action handler. Done when the L8 gate specs pass against
    the package handler.
  - **spaces:** `anchorMap` on capture. Done when a new scan gets an anchor from its joined capture GPS.
  - **drone:** fleet-route scoping (part of L6) and `mapsNear` at mission planning. Done when planning lists
    maps near the mission home.

## References

- Identity: `src/shared/middleware/authz.ts`; `src/shared/middleware/privileged-identities.ts`;
  `src/app/middleware/application-authorization-identity.ts`; `src/shared/services/database/request-identity.ts`;
  `src/shared/middleware/trusted-service-user-identity.ts`; `src/features/swarm-roles/services/swarm-role-store.ts`;
  ADR-148, ADR-149, ADR-157 (incl. Amendments B and C).
- Ownership and tenancy: `src/features/remote-client/services/device-access.ts`;
  `src/features/remote-client/services/node-token-scope.ts`; `src/app/routes/connector-tenancy.ts`;
  `src/app/routes/cli-token-routes.ts`; `scripts/migrations/060-platform-rls-tenancy.sql`,
  `102-cli-token-node-binding.sql`, `115-durable-remote-task-journal.sql`, `117-swarm-memory-provenance.sql`,
  `145-app-access-principal-issuer.sql`; ADR-042, ADR-076, ADR-114, ADR-124.
- Triggers and delivery: `src/features/scheduling/`; `src/app/home-schedule-dispatch.ts`;
  `src/app/trading-event-alerts.ts`; `src/app/routes/notify-routes.ts`; `src/features/notifications/`;
  `src/shared/package-tools/index.ts`; ADR-079, ADR-125, ADR-140.
- Spatial: `src/features/spatial-mapping/`; `src/features/drone/`; `store/drone/`, `store/spaces/`,
  `store/embodied/`; ADR-111.
- Privacy: `src/features/data-lifecycle/`; `src/features/governance/audit/audit-capture-middleware.ts`;
  `src/shared/logger/logger.ts`; `src/shared/middleware/guest-capability-matrix.ts`;
  `tests/unit/machine-write-identity.spec.ts`; ADR-100, ADR-105, ADR-122.
