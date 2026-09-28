# ADR-169: Location, places and proximity

Date: 2026-09-28
Status: **Proposed; the operator answered Q1-Q7 on 2026-09-28 (see "Operator decisions"). Slice L1 is built (shared geo maths, namespaced location redaction keys, static log guard); L2-L9 are not.**
The Context records what exists at core `main` `e1fd5b0f` and store `main` `6fdc1a1`. The Decision carries
the operator's answers; each Rollout slice is still accepted on its own.

Related: [ADR-042](042-iot-connector-tenancy.md) (personal vs household ownership),
[ADR-044](044-mobile-companion-app.md) (phone companion), [ADR-068](068-tv-surfaces-and-device-link-pairing.md)
(device-link pairing, reused by the Android phone node), [ADR-100](100-ambient-person-model.md) (consent for
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
| Phone | Only the installable cockpit PWA, reached by QR code. There is no phone node. ADR-044 Phase 4 (`device.location`) is not built, and ADR-140 D8 says a phone node must be native. The only native Android code is `packages/oshal-firetv`: a Kotlin/Gradle Fire TV WebView surface that signs in by device-grant pairing and was compiled and sideloaded on a real device. Its manifest declares only network permissions. | `src/pages/cockpit/tools/devices.html:121-131`; ADR-044:57,70-87; `packages/oshal-firetv/README.md:7,34`; `packages/oshal-firetv/app/src/main/AndroidManifest.xml:4-5`; ADR-068:5-8 |
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
| **Phone (cockpit PWA)** | Browser Geolocation, posted by the page while it is open. | The web API gives no position after the page closes. This is the only source for iPhone users, because iOS cannot be compiled here (Q7). A browser fix never causes a risk-increasing physical action (D4 evidence rule). |
| **Phone (Android node)** | OS location, posted in the background by the Android phone node (slice L9) to the core device ingest route under its location device credential (D3). | Built for Android because iPhone cannot be compiled here (Q7). This ADR starts it from `packages/oshal-firetv` and ADR-044's phone-as-node role. Its credential is device-bound, so its fixes are the evidence the D4 rule accepts for act on arrival. |
| **OSHAL Node (desktop)** | An **assigned place**, set by the owner in the Settings **Location** tab. | A stationary machine is modelled as "is at place P", not as a track. v1 takes no heartbeat fix (D7). |
| **Drone** | MAVLink `GLOBAL_POSITION_INT`, from the telemetry it already produces, posted to the core device ingest route under its own credential (D3, L6). | Embodied PX4 reports local NED only. It gets a place only through its scene's anchor (D3). |
| **Smart-home hub device, camera, TV** | An assigned place, plus a room label. | SmartThings location and presence are not read today. A hub device has no credential of its own; it is reached only through its owner's connection. Hub presence would therefore be a separate evidence source, read through that connection, and needs its own slice before the D4 evidence rule admits it. |
| **Simulated sat-node** | Out of scope. | Its position is orbital simulator state from the TLE catalog, not a place. |
| **Bot** | None of its own. A bot-node is at the place of the host device it runs on; an inline concierge has no place. | A container has no place. "Where is the home-bot" means "where are the devices it controls". |

**`location_devices` records who owns a device's location data. It grants no control or execution right.**
It is never a second source of device-ownership truth:

- **Person-owned.** The owner is a person's subject (`owner_sub` + `principal_issuer`). For a node, only its
  ADR-114 owner (the registry `ownerSub` and the `remote_task_journal_client_owners` row) may enrol it.
- **Swarm-owned.** The owner is a group (Q1), such as the household group: an existing tenant (`tenant_id`,
  an `oshal_tenants` row of the default `space` kind, `src/app/routes/connector-tenancy.ts:436-442`) with its
  members in `oshal_tenant_memberships`, using the 060 personal-or-tenant shape without its `is_operator`
  branch (D3). A person who is an admin of a group may assign their own node's *location data* to that
  group; a non-admin member cannot. The node itself stays person-owned under ADR-114.
- **Phones.** The Android phone node (L9) is person-owned: its `location_devices` row names the person who
  approved its location enrolment, and records the exact credential minted for it (D3). That credential is
  admitted only on the device's own presence path, so the phone cannot register as a remote client for work
  and never appears in `canUseDevice` or `remote_task_journal_client_owners`.
- **ADR-114 is not amended.** `canUseDevice` and `remote_task_journal_client_owners` are unchanged. That gate
  decides whether work runs on someone's computer with `danger-full-access` (`device-access.ts:2-6`), not who
  may see where it is. A tenant branch there would let any member dispatch work to a swarm node, which is the
  incident class ADR-114 closed. Tenant-usable nodes need their own ADR.
- **Drones and cameras** have no owner record. Only an admin of a group may enrol one, and only to that
  group.
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
| "The general swarm" as an owner | A **group** (Q1), such as the household group | An existing tenant: `oshal_tenants` (default kind `space`) plus memberships (ADR-042), using the 060 personal-or-tenant shape without its `is_operator` branch (D3). There is no separate swarm tenant kind. Only the group's admins change its places, devices and rules, enforced in RLS by `oshal_is_tenant_admin` (D3). Each member chooses whether to share their own location with the group (D6). |
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

**Separate everyday account: not now (Q6).** The operator decided against it for now, because the single
account is working. The analysis below is kept as the record of why it could matter later. In that split,
the management account holds root and a second, ordinary `user` account owns the operator's personal
devices, places, rules and location. What it would change: (1) everyday sessions stop carrying
`is_operator = on` across every other owner-RLS table, because operator status is decided per identity;
(2) the everyday account can erase itself through `/api/me`, which root cannot; (3) audit separates
administrative from personal actions.

**Precondition, if it is adopted later.** The split holds only if the everyday account's email is on no
root/admin `swarm_roles` row and in no `OSHAL_OPERATOR_EMAILS` entry, and its sub is not in
`OSHAL_OPERATOR_SUBS`. Operator status matches email case-insensitively with no issuer check
(`privileged-identities.ts:63`; `authz.ts:117-119`). A second account on the admin's email, for example a
local-auth account on the same Gmail address, would still be stamped `is_operator = on` and refused
`/api/me` deletion.

Its costs would be: the everyday account needs explicit app grants, because staged apps are adopted by the
install owner (`install-owner.ts:6`); `NOTIFY_EMAIL_SENDER_SUB` must be set if the personal Gmail moves to
it; `OSHAL_OPERATOR_EMAILS` keeps naming the admin identity. Sole-operator self-approval is unaffected while
the everyday account is not an admin (`src/app/composition/sole-operator-approval.ts:120-128`). The location
feature does not depend on this split: under D3 and D6 the location tables carry no operator bypass (Q2),
however the accounts are arranged.

### D3. The core data model: kernel skill `location`

A new FSD slice, `src/features/location`, is registered as kernel skill `location` in `KERNEL_SKILLS`, with
its build-anchor re-export and a doc row. Packages reach it through `uses: location`. The shared geo math
(`GeoPoint`, `haversineM`, metres-per-degree) moves to `src/shared/utils/geo.ts`, so the slice does not
import the drone slice. The existing drone copies are left as they are. Storage is plain `DOUBLE PRECISION`
lat/lon with haversine, the career-corpus shape; PostGIS would be an image change and is not needed at
household scale.

Every table that can hold a person's data carries `owner_sub` + `principal_issuer`, which are NULL on tenant
rows. That is what `/api/me` export and delete discover (D6). The three Q5 tables are the exception: they are
tenant rows that name the member in `user_sub`, which discovery keys first
(`src/features/data-lifecycle/services/discovered-exporters.ts:31`); their RLS is below.

| Table | Holds |
|---|---|
| `location_settings` | One row per person: default precision class, bounded by a DB CHECK. There is no retention setting: history is kept until its owner purges it (Q4). |
| `location_devices` | One row per located device (`device_kind`, `device_ref`): the owner of its location data (`owner_sub`+`principal_issuer`, or `tenant_id`), an optional `carried_by_sub` (only when the owner is that person), an assigned `place_id` and room, `reporting_enabled` (default false), `precision_class`, `last_seen_at`, and `credential_id`: the exact `oshal_cli_tokens.id` the location enrolment route minted for it, NULL for a device that cannot report. No control right (D1). |
| `location_observations` | Fixes, insert-only for writers and deletable only by their owner's purge: owner columns (the carrying person, or the device's owner or tenant), `subject_ref`, source (`browser`, `android`, `mavlink`, `manual`, `hub`), minimised lat/lon, optional alt, `accuracy_m`, `observed_at` (client-reported), `received_at` (server). |
| `location_current` | One row per subject, upserted on ingest: owner columns, the latest minimised fix, the current place. Reads report its age. |
| `location_places` | Named places owned by a person or a tenant: `name`, `label` (home, work, grocery, other), a circle (centre plus `radius_m`), an optional owner-typed `address`, an optional `timezone`, `created_by_sub`. |
| `location_map_anchors` | A spatial map's geodetic anchor, **by reference**: `map_kind` (`spatial-scan`, later `embodied-scene`), `map_ref`, origin lat/lon/alt, heading, footprint radius, accuracy, anchor source, capturing device and time, an optional `place_id`, and the map's owner (person or tenant). No geometry is copied into core. |
| `location_shares` | A **member share**: a person's own grant of their `place-transitions` to a group (Q1). Owner columns (the grantor), `tenant_id`, the explicit set of that group's place ids the grantor approved (cap 20), the approval's geometry digest, expiry, revocation. |
| `location_guardian_shares` | A **guardian share**: a group admin's grant of a restricted member's `place-transitions` to named individuals (Q5). A tenant row: `owner_sub` NULL, `user_sub` = the minor, `tenant_id`, `granted_by_sub` (the admin), the grantees' `(sub, issuer)`, each a current member of that group, the explicit set of that group's place ids the admin approved (cap 20) and its geometry digest, revocation. Foreign key `(tenant_id, user_sub)` to `location_member_restrictions`, ON DELETE CASCADE. |
| `location_member_restrictions` | A tenant row (`owner_sub` NULL, `user_sub` = the restricted member) marking a restricted (minor) account in one group. It cannot share its own location; only a group admin can share it, and only with named members of that group (D6). It is created only when the account accepts a restricted invitation, and never for an account holding admin in that group. Foreign key `(tenant_id, user_sub)` to `oshal_tenant_memberships` (whose primary key it is, 060:58-64), ON DELETE CASCADE. |
| `location_restricted_invites` | A group admin's invitation of one account to join the group as restricted (Q5, L5). A tenant row: `owner_sub` NULL, `user_sub` and issuer = the invited account, `tenant_id`, `issued_by_sub`, expiry, `accepted_at`. |
| `location_share_presence` | Per (share, approved place): the subject's enter/exit state and `since`, which the evaluator keeps with the D4 hysteresis for every active member or guardian share. Owner columns for the subject. No coordinates. These are the only rows the grantee projection reads. |
| `location_rules`, `location_rule_state`, `location_rule_fires` | The proximity rules of D4; the per-(rule, subject) enter/exit state; and the fire ledger (`UNIQUE(rule_id, subject_ref, transition_id)`). State and fire rows carry owner columns for the **subject** (the person, or the subject device's owner or tenant), so a subject's presence rows are theirs to export, purge and erase. |

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
  shape of migration 145. The owner's own session may DELETE them; that is the purge (Q4). The Q5 tables
  are tenant rows with their own policies below, so the purge does not reach them.
- **Tenant rows** (`tenant_id` set, `owner_sub` NULL): SELECT for `oshal_is_tenant_member`; INSERT, UPDATE and
  DELETE only through a new SECURITY DEFINER `oshal_is_tenant_admin(tenant)` in `USING` and `WITH CHECK`. A
  non-admin member cannot move a tenant geofence, subject or action. Both helpers are sub-only (060:83-88).
  The Q5 tables narrow this, below.
- **The membership fence.** A BEFORE INSERT and BEFORE UPDATE OF `tenant_id, user_sub, role` trigger on
  `oshal_tenant_memberships` requires the writer to be an existing admin of the target tenant, regardless of
  `is_operator`, or the insert to redeem a restricted invitation a current admin of that tenant issued to
  that account (D6). The creator is allowed only for a tenant's first row. Both core writers already satisfy
  this (`connector-tenancy.ts:445` creates the tenant with its creator as admin; `:458` runs after the app
  admin check). Self-service `display_name` updates (`src/app/routes/privacy-routes.ts:338`;
  `src/features/speaker-diarization/speaker-profile-store.ts:605`) do not fire it. Members who share
  presence with the tenant are notified when membership changes. This and the location credential (below)
  are the two changes this ADR makes outside the `location_*` tables.
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
  an accepted share whose place set contains the rule's place. The same shape covers
  `location_share_presence`, where the predicate confirms that the share is active, names the subject and
  contains the place. There is no DELETE policy for subjects as writers; a person deletes the state, share
  presence and fire rows they own only through their purge.
- **Devices.** A `device:<id>` subject may INSERT observations whose owner columns match what
  `location_devices` records for it (a SECURITY DEFINER predicate). It may read that owner's places and the
  rules naming the device, and write evaluation state as a subject. It reads no observations.
- **Member shares.** A SECURITY DEFINER predicate backs the `location_shares` `WITH CHECK`: the grantor is a
  member of the group, every approved place is that group's and meets the D6 radius floor, and the set holds
  at most 20. A member share is refused when a `location_member_restrictions` row names the grantor. The
  grantor's own session revokes it.
- **Restriction rows** are tenant rows (`owner_sub` NULL, `user_sub` = the restricted member). There is no
  direct INSERT path, even for an admin: a restriction is written only by the SECURITY DEFINER acceptance
  function when the invited account accepts a restricted invitation that a current admin of the group issued,
  and the function refuses an account that holds admin in that group. UPDATE and DELETE go only through
  `oshal_is_tenant_admin`. The member and the group's admins may SELECT. The member cannot delete their own
  restriction. The foreign key to `oshal_tenant_memberships` cascades, so leaving the group or erasing the
  account removes the restriction, and with it that group's guardian shares.
- **Restricted invitations** are tenant rows written only through `oshal_is_tenant_admin`. The invited
  account may SELECT and decline (DELETE) its own, and accepts it only through the acceptance function.
- **Guardian shares** are tenant rows naming the minor in `user_sub`. INSERT and UPDATE are admitted only when
  the writer passes `oshal_is_tenant_admin` for the group whose restriction row names the minor, every
  grantee is a current member of that group, every approved place is that group's and meets the D6 radius
  floor, and the set holds at most 20. Only the group's admins may revoke or DELETE one. The minor may
  SELECT it and cannot delete it. It cascades from the restriction row.
- **Grantees read a projection.** No grantee policy exists on the base tables. A SECURITY DEFINER function
  returns `location_share_presence` rows only: a member share's to current members of its group, a guardian
  share's to its named grantees. On every read it re-checks that the share is unrevoked and unexpired, that
  the reader is still a member of the group, that the place is in the share's approved set, and, for a
  guardian share, that the minor is still a member and still restricted in that group. It returns place id,
  label, name, enter or exit and since, never coordinates.
- **Dispatch identity.** After commit, the evaluator switches identity in-process for each claimed fire row,
  to the rule's actor with `runWithRequestIdentity({sub, principalIssuer, isOperator: false})`. The
  precedent is `src/app/home-schedule-dispatch.ts:84`.
- **Crash recovery.** A sweep runs under its own broker GUC, `oshal.location_dispatch_broker`. Its `USING`
  admits only fire rows that are claimed and not yet dispatched, and it dispatches each under its actor as
  above. It is neither SYSTEM nor `is_operator`.
- **Purge is by the owner only (Q4).** A person purges person rows under their own identity; a group admin
  purges a group-owned device's rows through the tenant-row policy above. There is no purge broker GUC and no
  age-based delete.
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
  accepts only the exact credential recorded for that device, `location_devices.credential_id`. The token must
  be unrevoked and its `(user_sub, principal_issuer)` must equal the device's owner; for a tenant device, the
  token's user must be a current admin of the owning group. A matching device id is not enough:
  `/api/join/enroll` accepts a caller-named `clientId` behind `requiresAuth` alone
  (`src/app/routes/join-routes.ts:170-187`; `src/app/server.ts:1221`), `node_client_id` has a non-unique
  index (migration 102:18-19), and `GET /api/cli-tokens` returns each node token's label, which names its id
  (`cli-token-routes.ts:522-533`; `join-routes.ts:201`). So any signed-in account, or a same-origin package
  script running as the person, could otherwise mint a second token for a device's id.
- **Location enrolment.** The credential is minted by a core location-enrolment route that requires the step-up
  proof (below), mints the device id on the server, and writes `credential_id` in the same transaction.
  Rotation goes through the same route and replaces `credential_id`. The token is an `oshal_cli_tokens` row
  with a new nullable binding column, `location_device_id`, and no `node_client_id`, so `decideNodeTokenScope`
  never admits it to the worker plane (`src/features/remote-client/services/node-token-scope.ts:42-45,97-118`).
  The token-auth middleware applies the location scope whenever that column is set, before the account-PAT
  path: the token is admitted only on `POST /api/location/devices/<its device id>/presence` and refused
  everywhere else, including `/api/remote-clients/register`. `/api/join/enroll` refuses a `clientId` that
  names a `location_devices` row. A phone reaches the enrolment route by the ADR-068 device-grant shape (L9);
  a group admin enrols a drone through the same route (L6).
- **Device identity.** The ingest route derives `device:<id>` from the verified binding, never from the body.
  Before it writes, it replaces the request's stamp, because the credential authenticates as its minting user
  and may be operator-stamped, with `runWithRequestIdentity({sub: 'device:<id>', isOperator: false})`. Its
  credential check joins `MACHINE_AUTH_MARKERS` and it gets an inventory entry, so
  `machine-write-identity.spec.ts` discovers it. The drone node (L6) and the Android phone node (L9) post
  here.
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

**Retention: kept until the owner purges it (Q4).** Location history is the person's own data. There is no
automatic expiry and no retention class for a person's own history.

- Observations, and the rule state, share presence and fire rows whose subject a person is (including a
  fire's evidence provenance, D4), are history, kept until that person purges them.
- The `location_current` row is current state, not history: opting the device out clears it.
- The Settings Location tab offers the purge at any time. It deletes under the person's own identity (the
  RLS above). `/api/me` export and both account-deletion routes cover the same rows (D6).
- A swarm-owned device's history follows the same rule, with the group's admins as the ones who purge it.
- Places, rules and shares are kept until deleted. Opting a device out stops its ingest and clears the
  `location_current` row it fed; its history stays until the owner purges it.
- The purge and account deletion do not reach `connector_action_audit`. It is append-only and kept on
  erasure (`discovered-exporters.ts:44`, `RETAINED_DISCOVERED_TABLES`), and it is included in export. For each
  device-action fire it holds ids, the actor, the operation and the time, and no place or coordinates
  (D4 gate 5). For a person's rule, the time of every garage opening therefore outlives both.

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
  raise, accepting a share, creating a guardian share, approving a location enrolment and arming a
  device-action rule. Core has none of this
  today; L3 builds it, and `MOCK_OIDC` must be able to issue a fresh `auth_time` so it works on
  `localhost`. Owner coordinate reads need the same proof, valid for a short window. Within that window a
  same-origin package script can read what the Settings page can; the window bounds that exposure. Packages
  get labels only, through the kernel skill, on the server.
- **Models.** The model-safe reads (`currentPlace`, `distanceBand`) return a place label and name, a distance
  band and "since", never coordinates, addresses or trails. `operationAddress` never reaches a prompt (D5).
  The DLP redactor has no coordinate detector, so it is no backstop.
- **Geocoding: none in v1.** Places are created from the current fix ("here") or typed coordinates, and the
  address is text the owner types onto the place row. The rides script geocoder is not adopted: it defaults to
  public Nominatim, sends raw coordinates, and keeps results in a shared file outside RLS, purge and
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
contains the rule's place (D6). Sharing is each member's own choice (Q1), so a member who has not shared is
never evaluated, and a restricted (minor) member, who cannot share (Q5), is never evaluated by a group rule.
Separately, the evaluator keeps `location_share_presence` for each active member or guardian share at its
approved places, with the same hysteresis. That drives no action, and it is the only evaluation a restricted
member's fixes get on a group's behalf.

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
NAT (ADR-140 D6) and must not decide someone else's rule. The edge keeps a role: the Android phone node (L9)
posts fixes, and could later evaluate OS geofences locally and post transitions instead, which saves battery
and keeps raw tracks on the phone, but those transitions would be evidence the controller still decides on.

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
  2. **Explicit per-rule arming is the authorization; it acts on arrival (Q3).** The person who sets up the
     rule arms it, naming the exact device and exact operation. That is ADR-140 D5's pre-authorization of an
     exact operation on an exact device (ADR-140:136), so a qualifying transition runs the action with no
     per-opening confirmation. Only the actor can arm, and only with the step-up proof (D3). The handler
     accepts a rule fire because it verifies the armed rule and its `armDigest` (gate 4), not a `confirm`
     flag.
     **Evidence rule (a design choice, not a confirmation).** A risk-increasing entry fires only on fixes
     posted under a device-bound credential: today only the Android phone node's location credential (L9).
     It never fires on a browser-only fix, because a browser fix can be spoofed: the page posts coordinates
     it chose, and any same-origin package script can post them as the person (Context, rule 5). For a rule
     whose operation is risk-increasing, only device-bound fixes change its state: a browser fix neither
     enters nor exits it, though browser fixes still drive reminders and risk-reducing rules. A fix the
     reporter flags as mock location (L9) is treated like a browser fix, and the flag is kept in the evidence
     provenance. A device-bound credential is confined to the one device it was minted for (D3). A rule with a
     risk-increasing operation cannot be armed unless its subject has such a device, and the Settings
     Location tab says why. For an `anyMemberOf` rule, arming needs at least one sharing member with such a
     device, and each fire still needs the arriving member's qualifying fixes to come from their own
     device-bound credential. Hub presence is not an evidence source until its own slice admits it (D1).
  3. **Presence confidence floor.** The qualification rules above apply, with no late events.
  4. **Recheck at every fire.** The actor must still hold the connection, personal or household (ADR-042),
     and for a tenant rule must still be a tenant admin. The rule must still be armed and the device must
     still exist. Arming stores `armDigest`, a digest over a canonical serialization of every field that
     affects firing: owner, subject, place id and geometry, `on`, `repeat`, `cooldownSec`, the accuracy
     floor, the action kind, device, operation and, for a person or device subject, the subject's
     device-bound credential id. Every fire re-verifies it, so any edit by anyone to any of these disarms
     the rule.
  5. **Audit.** Each fire writes a fire-ledger row with its evidence provenance (`device_ref`, source, auth
     mode, mock flag, `accuracy_m`, `received_at`, no coordinates), kept as long as the fire row. It also writes
     `connector_action_audit` with a params hash (ADR-105), carrying ids only. There is no per-fire ticket.
  6. **Bounded direction, failure closed.** Risk-increasing entries fire only on `enter`. `exit` may fire only
     entries the handler tags risk-reducing, and the evidence rule (gate 2) binds only risk-increasing
     entries, because a risk-reducing one only makes things safer (the confirm-exempt drone fleet-abort
     precedent, `src/features/drone/services/drone-service.ts:268-273`). A failed gate means no action plus a
     notification of the reason. A rule whose subject's feed has gone silent shows "not watching since …"
     (the ADR-125 absence alarm).

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
picks a precision class (the browser adds its own prompt; the Android phone node asks for the OS location
permission). Opting out stops ingest and clears the `location_current` row that device fed; its history stays
until the owner purges it (Q4, D3).

| Viewer | What they can see of a person's location |
|---|---|
| The person | Everything that is theirs. Coordinate reads need the step-up proof (D3). |
| Another person | Nothing, except a member of the same group named on a guardian share of a restricted (minor) member (Q5), who sees that minor's place transitions at the share's approved places through the projection function. Shares between adults are deferred (D7). |
| Group members (for example, the household group) | Group places, group rules and group-device positions. A member's place transitions only if that member chose to share with the group (Q1), and only for the places approved in the accepted share, through the projection function. Only group admins change group rows. |
| Swarm root/admin | Nothing personal by virtue of the role (Q2). The remote-client node list shows online state and last seen, and carries no position. The drone package's `/state`, `/fleet` and `/fleet/:id/state` return live position and home to any authenticated caller today (`drone-types.ts:127-128`; `drone-fleet.ts:32`; `store/drone/src-routes/drone-routes.ts:288-293,378,387,511`); L6 tenant-scopes them. The records a fire leaves outside the location tables carry ids only, so an admin can see that a fire happened and when, but not where or what. The exception is `connector_action_audit`, which names the actor, operation and time of every device action and is kept forever; the consent screen says so. Admins see tenant data as members. This adopts ADR-149's recommended "no automatic business-record access" (ADR-149:59-61,396) for the location tables only; it does not decide the platform-wide question. There is no break-glass read. The administrative remedies are to revoke a device or remove a member. |
| Background / SYSTEM | Nothing, except the dispatch-recovery sweep under its own broker GUC. Nothing is purged in the background (Q4). |
| Models | Place labels, names and distance bands only. |

- **Group shares are each member's choice, and they name their places (Q1).** In a group, such as the
  household group, each member chooses whether to share their own location with that group; nothing is
  shared by joining. A member shares `place-transitions` with a group by approving an explicit set of group
  place ids, capped at 20. A group rule evaluates that member only at a place in the set. Adding a place, or
  changing an approved place's geometry, needs re-acceptance. A tenant place used for a member must have a
  radius no finer than that member's precision class (`block` 110 m, `city` 1.1 km), so a tenant cannot
  rebuild a track finer than the member chose; tenant places default to a 150 m radius for that reason. The
  member can list every tenant rule that names them (owner, place, kind, action class) and revoke.
  Revocation stops evaluation and ends the share. The member's rule state, share presence and fire rows
  under that group's rules stay theirs until they purge them (Q4).
- **Minors (Q5).** Core has no account-level minor attribute (Context). The enforcement input is
  `location_member_restrictions`. A restriction exists only when the invited account accepts a restricted
  invitation from a group admin, and never for an account holding admin in that group (D3). Today any
  signed-in account can create a group and become its admin (`src/app/routes/tenant-routes.ts:61-72`;
  `connector-tenancy.ts:437-449`), an admin adds members with no acceptance by the person added
  (`tenant-routes.ts:76-89`; `connector-tenancy.ts:453-462`), and invitations are deferred to ADR-042 Phase 3
  (`tenant-routes.ts:7`). Without the acceptance step, a stranger could add an adult to a group they made and
  mark them restricted; L5 builds it. A restricted member cannot share their own location: they cannot
  create or accept a member share, so no group rule evaluates them. A group admin (the guardian) can share a
  restricted member's location with specific named individuals, for example family members who want to see
  their family. The guardian share is bounded by the group:
  - each named individual must be a current member of the same group, so a relative outside the household is
    added to the group first, which only an admin can do (the D3 membership fence);
  - the admin chooses an explicit set of that group's place ids, capped at 20 with the same radius floor as
    a member share, and the named individuals see the minor's place transitions at those places only,
    through the projection function (D3), never coordinates;
  - the projection re-checks on every read that the share is unrevoked, the reader is still a member, and
    the minor is still a member and still restricted in that group;
  - creating a guardian share needs the admin's step-up proof (D3); only an admin of that group can revoke
    or delete it, and the minor cannot;
  - the restricted member's "who can see me" list shows each guardian share and its grantees.

  An account outside every group has only its own, owner-only data.
- **Deletion and takeout.** Every person-bearing table carries `owner_sub`, so `/api/me` export and delete
  discover it (`src/features/data-lifecycle/services/discovered-exporters.ts:31,176,182`). For rule state and
  fires, the owner is the **subject**, so a member's presence rows under a tenant rule are exported and erased
  with that member. Tenant rows keep `owner_sub` NULL plus `created_by_sub`, because the discovered delete
  ignores `tenant_id` (`:182`), so a creator's erasure does not delete household places. Both erasure routes
  call one location erase function: `/api/me/delete-confirm`, which runs the discovered deletes
  (`src/app/routes/data-lifecycle-routes.ts:170`), and the hand-enumerated `DELETE /api/privacy/me`, which
  today deletes only tasks, messages, tickets, ambient and Jarvis data
  (`src/app/routes/privacy-routes.ts:75-85`). The function deletes the person's `location_*` rows, revokes
  their location device credentials and clears the evaluator's in-memory state for them. Restrictions and
  guardian shares go with the person's membership (the D3 cascade), and their own pending restricted
  invitations are deleted as theirs. Separately from account deletion, a person can purge
  their location history at any time (Q4, D3).
- **Audit.** Consent, shares, arming and every device-action fire are audited as D4 describes. Ingest is
  not audited per fix; the observation table, kept until its owner purges it, is the record, and a fire's
  evidence provenance traces it to the device, source and auth mode that caused it.
- **Fixtures.** Tests use synthetic coordinates and never real addresses. Map screenshots stay out of the
  tree except in curated directories, as the publish gate requires.

### D7. Not decided or built here

- **No iPhone node.** iOS is out of scope because it cannot be compiled here (Q7). iPhone users get
  foreground location through the installable web app (ADR-044 Phase 1), which cannot fire a risk-increasing
  physical action under the D4 evidence rule.
- **No ADR-044 Phase 4 remote-client registration for the phone.** The Android phone node (L9) posts fixes to
  the device ingest route only, and its credential is refused on the worker plane (D3). It adds no `android`
  value to `RemoteClientPlatformSchema` (`src/shared/types/a2a.ts:34`) and no device MCP tools.
- **Open question for the operator: position granularity.** v1 shares place transitions at approved places
  only. Whether "share your location" (Q1) or "see their family" (Q5) needs a position granularity
  (`coarse-position`) as well is his to decide; this ADR does not add one.
- **No person-to-person sharing between adults.** The only share to an individual is a guardian share of a
  minor (Q5). No polygons, time windows, `dwell` or `until:<date>`. These were not requested; each is a
  follow-up if asked for.
- **No guardian control of a minor's reporting.** Q5 decides sharing only. A minor's device reports under the
  same per-device opt-in as anyone's (D6), and a guardian share shows transitions only while it does.
- **No scene arming** and **no kernel geocoder** in v1 (D3, D4).
- **No node heartbeat fix.** A node has an assigned place only. The heartbeat field arrives with a node that
  can sense a position, and then only under a node-bound token for its own clientId. It is dropped in the
  shared-secret auth mode and for any session caller who is not the owner
  (`src/app/routes/remote-client-routes.ts:235,288-321,334-341`).
- **No change to ADR-114 or `canUseDevice`** (D1).
- **No other platform-wide change.** The operator bypass on other tables and ADR-149's platform-wide admin
  policy are unchanged. Outside the location tables, this ADR changes only the membership trigger and the
  location credential (the `location_device_id` column on `oshal_cli_tokens`, its scope check and the
  `/api/join/enroll` refusal) (D3).
- **No category places.** "Any grocery store" needs a POI source. In v1, "the grocery store" resolves to the
  person's saved places with that label; with none, Jarvis offers to save "here" (L5).
- **No web push and no PostGIS**, and drone geo math is not refactored.

## Consequences

**Gained.**

- One consented, owner-scoped location and places store replaces five per-package copies.
- Reminders and triggers fire on place, not only on time, over the existing delivery, workflow and
  device-write rails. A drone's maps can be looked up by position, whether or not the capture was in a saved
  place.
- "The general swarm" is a group, such as the household group, with named admins, instead of the operator's
  personal subject, and each member chooses whether to share their location with it (Q1).
- For location, "administers the swarm" and "reads a member's rows" are separated by policy and a guard (Q2).
  That is the ADR-149 target, met for one person-owned data class.
- Location history is the person's own data, kept until they purge it and covered by export and account
  deletion (Q4). The exception is `connector_action_audit`: included in export, not removed by purge or
  erasure (D3 Retention).
- Android users get background arrival detection from the phone node (L9), which is the enrolled-device
  evidence a risk-increasing rule such as the garage needs before it can be armed (D4 evidence rule); once
  armed it acts on arrival with no confirmation (Q3).

**Costs and risks.**

- Removing the bypass means an admin cannot debug another person's location rows; their tools are health and
  counts.
- Browser location stops when the page closes. iPhone users therefore get arrival rules only while the web app
  is open, and cannot be the subject of an armed risk-increasing device action (D4 evidence rule, Q7).
- A relative outside the household must be added to the group before a guardian share can name them, and as
  a member they then see what any member sees of the group (D6).
- The restricted invitation is new tenancy code, because ADR-042 Phase 3 invitations do not exist; L5 builds
  it and it needs its own RLS proof.
- The location credential adds a binding column and a scope check to the token-auth path every CLI token
  uses, and needs its own proof that it never widens an account PAT or a node token.
- Nothing is deleted by age, so the observation tables grow until owners purge them (Q4).
- The Android phone node is a second native client to build, sign and install. The Fire TV project it starts
  from is built by hand, not in CI (`packages/oshal-firetv/README.md:53`).
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
5. **The stock owner policy with the operator bypass, disclosed.** Rejected (Q2): every admin session would
   see every member's location.
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
12. **A dedicated swarm tenant kind** (`kind = 'swarm'`, at most one). Not taken (Q1): any group, such as
    the household group, serves as a swarm group.
13. **Confirming every opening on arrival** (the earlier "ask on arrival" default). Rejected (Q3): the person
    who sets up the rule has already authorized it.
14. **Automatic expiry by retention class.** Rejected (Q4): history is the person's own data, kept until they
    purge it.
15. **Blocking location entirely for restricted (minor) accounts.** Replaced (Q5): a minor cannot share, and
    a group admin can share for them with named individuals.
16. **Foreground-only arrival detection, with no phone app.** Rejected (Q7) for Android. It remains the only
    option for iPhone, which cannot be compiled here.
17. **ADR-044 Phase 2's Capacitor shell as the phone node.** Not taken: the operator said "we have something
    for android" (Q7), and the only Android code in the core, store and private repositories is
    `packages/oshal-firetv`, which ADR-068 records as compiled and sideloaded on a real device
    (ADR-068:5-8).

## Operator decisions (2026-09-28)

Each entry quotes the operator, states his rule, and then labels separately what this ADR adds that is not
part of his answer.

- **Q1: the swarm group.** "in a swarm group you can choose to share your location. The household swarm
  group is a good example." **Rule:** any group (an `oshal_tenants` row of the default `space` kind, with its
  memberships) is a swarm group; the household group is the operator's example; there is no separate swarm
  tenant kind. Each member chooses whether to share their own location with a group, per member and per
  group. **This ADR's choices (not part of the answer):** what is shared is place transitions at approved
  places, never coordinates; that granularity is this ADR's choice, and whether he wants a position
  granularity as well is open (D7). Only a group's admins change its places, devices and rules (D1, D2, D3,
  D6).
- **Q2: admin visibility.** "correct" **Rule:** the location tables have no operator or admin bypass; the
  recommendation stands (D3, D6).
- **Q3: garage pre-authorization.** "no you wouldnt need to confirm you set the action up so it runs based on
  the trigger" **Rule:** act on arrival is pre-authorized by the person who sets the rule up; there is no
  per-opening confirmation.
  **Kept by this ADR (not part of the answer):** every gate that does not ask for confirmation stays:
  arming, the arm digest that disarms on any edit, the confidence floor, the cooldown, the closed command
  allowlist, never through a model, and the audit row. So does the D4 evidence rule, a design choice and not
  a confirmation: a risk-increasing physical action fires only on fixes posted under a device-bound
  credential, today only the Android phone node's (L9), never on a browser-only fix, because a browser fix
  can be spoofed. Without such a device the rule cannot be armed, and the Settings Location tab says why.
  A user whose only phone is an iPhone therefore cannot be the subject of an armed risk-increasing rule
  (D4, D7).
- **Q4: retention.** "it should be stored in the users data and is kept until they purge it" **Rule:**
  location history is the person's own data, kept until they purge it. There is no automatic expiry and no
  retention class for a person's own history. Export and account deletion cover it, and the purge is
  available at any time. A swarm-owned device's history follows the same rule, with the group's admins as
  the ones who purge it (D3, D6).
- **Q5: minors.** "minors can not share however the admin can share for them to specific individuals.. for
  example family would want to see their family" **Rule:** a restricted (minor) member cannot share their
  own location. A group admin can share a minor's location with specific named individuals, for example
  family members (a guardian share, D6). **This ADR's choices (not part of the answer):** what is shared is
  place transitions at approved places, never coordinates; that granularity is this ADR's choice, and
  whether "see their family" needs a position granularity is open (D7). The named individuals must be
  members of the same group, and a restriction is set only when the invited account accepts a restricted
  invitation, never on a group admin (D3, D6).
- **Q6: account split.** "no i dont think we need an every day account right now it seems to be working"
  **Rule:** no separate everyday account now. The D2 analysis stays as the record of why it could matter
  later.
- **Q7: phone node.** "yes we need a phone app but we cant compile for iphone... we have something for
  android" **Rule:** build an Android phone node; iPhone is out of scope.
  **This ADR's reading (not part of the answer):** the only Android code in the core, store and private
  repositories is `packages/oshal-firetv`, so the phone node starts from it, in the phone-as-node role of
  ADR-044. It posts fixes to the device ingest route under a device-bound credential (L9). iPhone users get
  foreground location through the installable web app (ADR-044 Phase 1), which cannot fire a
  risk-increasing physical action under the D4 evidence rule (D1, D7).

## Rollout (slices with done-when)

Each slice is its own PR, ships its behaviour tests plus Test Lab registration, and keeps "locally tested"
separate from "live-proven". The operator decisions (2026-09-28) settle every question the slices were gated
on; what remains is order by dependency.

- **L1: Shared geo and log guard.** `src/shared/utils/geo.ts`; the namespaced redaction keys; the static
  log guard over `src/features/location` and the location routes. Done when the guard's spec goes red on a
  planted logger call that passes a depth-3 telemetry object (`telemetry.position.lat`) or an error carrying a
  URL, and typecheck passes on the committed tree.
  **Built:** `src/shared/utils/geo.ts` (haversine, circle containment, the four precision classes and their
  rounding, distance bands); `location`, `*.location`, `coords` and `*.coords` in `LOG_REDACT_OPTIONS`;
  `locationSafeError` in `@/shared/logger`, the one error shape the guard admits; the guard itself
  (`tests/helpers/location-log-guard.ts`, run by `tests/unit/location-log-guard.spec.ts`), whose scope is
  derived from the tree; and the Test Lab card `location-log-safety`. The drone copies are unchanged.
- **L2: Storage and RLS (no operator bypass; history kept until the owner purges it).** Migrations for
  `location_settings`, `location_devices`, `location_observations`, `location_current`, `location_places`,
  `location_shares`, `location_guardian_shares` and `location_member_restrictions`, with the no-bypass
  policies, `oshal_is_tenant_admin`, the membership trigger, the owner purge policies, the Q5 tenant-row
  policies and the share predicates; the location erase function called by both erasure routes; the
  kernel-skill registry entry and doc row; guest Tier C. There is no expiry column, expiry trigger or purge
  broker GUC.
  Done when a live two-role RLS spec against the enforcing role proves all of the following:
  - an owner reads their rows and a stranger reads nothing;
  - a group member reads group rows but cannot write them;
  - an admin session reads no other person's rows;
  - an admin or operator-stamped session cannot add itself to a group and then read that group's rows,
    while both existing membership writers still succeed;
  - SYSTEM is denied;
  - an owner's purge deletes their own observations and current row (counted before and after) and no one
    else's; a group admin purges a group-owned device's observations and a non-admin member cannot;
  - a member share by a restricted member is refused, and only an admin of the minor's group can write a
    guardian share;
  - a direct INSERT of a restriction is refused, even by an admin, so an existing member cannot be restricted
    without an accepted restricted invitation; a non-admin member cannot write or delete a restriction; the
    minor cannot delete their own restriction or a guardian share naming them; erasing the minor removes the
    restriction and that group's guardian shares;
  - a guardian share naming a grantee outside the group, a place outside the group, or more than 20 places
    is refused;
  - `/api/me/delete-confirm` and `DELETE /api/privacy/me` each remove the person's observations and current
    row, revoke their location device credentials and clear the evaluator's state for them.

  Also: the static no-`is_operator` guard goes red on a planted bypass, and `rls-core-table-coverage-live`
  passes.
- **L3: Browser ingest, consent and step-up.** `/api/location/presence`, the step-up proof, and the Settings
  Location tab (per-device opt-in, precision, purge, "who can see me"). Done when a human on `localhost` with
  `MOCK_OIDC` can opt a browser in, see their current place, opt out and see ingest stop while the history
  stays, then purge and see the rows gone. Specs prove that a body-supplied owner is ignored, that a
  service-secret request is refused, and that a fetch from a packaged surface without a fresh proof cannot opt
  in, raise precision, accept a share, create a guardian share, approve a location enrolment or arm a rule.
- **L4: Places and device enrolment.** Circle places, tenant places, `placeAt`, `currentPlace`,
  `distanceBand` and `operationAddress`. Enrolling an existing node, camera, TV or hub as a `location_devices`
  row, and setting or clearing its assigned place and room, all in the Settings Location tab. Done when specs
  cover containment edges and ownership refusals; a node, a camera and a TV each show an assigned place that
  the owner can change and a non-owner cannot; and a non-admin cannot enrol a drone or camera to a group, or
  assign their own node's location data to it.
- **L5: Reminders.** The rules, state and fire tables with their subject, dispatch-recovery and projection
  paths; `location_share_presence` and the grantee projection; the evaluator; two-rail delivery with
  tier-aware text; member shares with place sets (Q1) and guardian shares of minors (Q5), with
  `location_restricted_invites` and the acceptance function that creates a restriction; subject
  visibility; the Jarvis "next time I'm at X" intent, including
  "here" and "this store", which proposes a new
  place at the current fix (confirm name, label, radius). Done when:
  - a scripted fix sequence proves edge jitter does not double-fire, exit hysteresis holds, and cooldown,
    `once` versus `every-visit` and stale fixes behave as specified;
  - a back-dated `observed_at` does not qualify a fix;
  - a 100 m place fires correctly for a person stored at `block`;
  - a member who has not shared with the group is never evaluated by a group rule, and a member is never
    evaluated for a place outside their approved set; a set above the cap, a foreign place id and a foreign
    device subject are each refused;
  - after a member revokes a share, their rule state, share presence and fire rows remain theirs until they
    purge them, and the projection returns nothing for that share;
  - a restriction exists only after the invited account accepts a restricted invitation from a current
    admin, and an invitation naming an admin of the group is refused;
  - a restricted member cannot create or accept a share; a guardian share lets each named individual read
    the minor's transitions through the projection function, returns transitions only for its approved
    places and no coordinates, gives nothing to anyone else, and returns nothing after revocation, to a
    grantee removed from the group, or once the minor has left the group or is no longer restricted;
  - the restricted member's "who can see me" list shows each guardian share and its grantees;
  - a scripted "I'm at the grocery store, remind me next time" creates the place and the rule, and the rule
    fires on the next visit;
  - after another person's fire, an admin session reading `tickets` and `jarvis_tasks` finds no place,
    subject or reminder text, and a `deployment`-tier message carries only the generic text;
  - after member B is erased, the group's rule tables hold no row naming B;
  - a Test Lab scenario passes.
- **L6: Group ownership, location credential and drone ingest.** Swarm devices owned by a group, such as the
  household group, with no new tenant kind; the location enrolment route, the `location_device_id` binding on
  `oshal_cli_tokens` and its scope check, and the `/api/join/enroll` refusal (D3); the core device ingest
  route and its `MACHINE_AUTH_MARKERS` entry; the drone node posting fixes under a credential a group admin
  enrolled; and a store drone PR that tenant-scopes `/state`, `/fleet` and `/fleet/:id/state`, or strips
  position for non-members. `canUseDevice` and `remote_task_journal_client_owners` are untouched. Done when:
  - `machine-write-identity.spec.ts` discovers and covers the ingest route;
  - ingest refuses a credential bound to a different device, a node-bound token for the same id (and
    `/api/join/enroll` refuses to mint one), a token minted by a different account for the same id, and a
    service-secret request;
  - a location credential is refused on `/api/remote-clients/register` and on every path but its own
    device's presence path, and an account PAT or node token is unchanged by the new column;
  - a non-member gets no position from the location reads or from the three drone routes.
- **L7: Map anchors.** `location_map_anchors`, `anchorMap`, `mapsNear`, capture GPS joined to its scan, and
  `tenant_id` on `spatial_scans` (ADR-111 amendment). Done when a scan captured inside place P and a scan
  captured outside every saved place are both returned by `mapsNear` on a later visit, and a non-member cannot
  open them.
- **L8: Device-action triggers (act on arrival, no confirmation; enrolled-device evidence).** The home
  package handler with its closed allowlist, registered through `package-tools`; arming as the
  pre-authorization; the evidence rule. Done when:
  - an armed rule fires on qualifying device-bound fixes with no confirmation prompt and no `confirm`
    flag;
  - specs prove no fire below the confidence floor, when unarmed, after the connection is revoked, inside the
    cooldown, on a late event, on a browser-only fix for a risk-increasing entry, on a fix flagged as mock,
    for an unlisted or `set` command, or for a risk-increasing entry on exit;
  - editing each field in the arm digest (owner, subject, place id and geometry, `on`, `repeat`,
    `cooldownSec`, accuracy floor, action kind, device, operation, the subject's credential id) disarms the
    rule;
  - a browser-fix exit followed by device-bound inside fixes does not fire, and a browser-qualified enter
    does not suppress a later device-bound enter;
  - a rule with a risk-increasing operation cannot be armed when its subject has no device-bound credential,
    and the Settings Location tab shows the reason; an `anyMemberOf` rule cannot be armed when no sharing
    member has one, and does not fire on an arriving member's browser fixes;
  - a risk-reducing entry fires on exit from a browser fix;
  - a location fire never reaches `executeBotOrInline`;
  - each fire writes one fire-ledger row with its evidence provenance, including the mock flag;
  - an admin session finds no place, subject or reminder text in `tickets`, `jarvis_tasks` or
    `connector_action_audit` beyond the disclosed audit row.

  Live acceptance on a real hub with the Android phone node (L9) is the operator's external step.
- **L9: Android phone node (after L6).** A new package, `packages/oshal-android`, started from a copy of the
  `packages/oshal-firetv` Gradle project, the only Android code in the core, store and private repositories.
  It is a sibling, not a mode of the TV app, because that app's stated scope is "Surface only — no inference,
  device aggregation, or tokens beyond the pairing token" (`packages/oshal-firetv/README.md:91`) and its
  activities are landscape TV screens (`app/src/main/AndroidManifest.xml:27,39,44`). What it reuses:
  - the Gradle build: root `build.gradle` (Android Gradle plugin 8.2.2, Kotlin 1.9.22), `settings.gradle`,
    and `app/build.gradle` (compile and target SDK 34, JDK 17, Robolectric JVM tests);
  - `Config.kt`'s host-URL setting and `Net.kt` (a dependency-free `HttpURLConnection` JSON POST);
  - `PairingActivity.kt`, the ADR-068 device-grant sign-in, for showing the cockpit: the phone shows a code
    from `POST /api/tv/pair/start`, the person approves it in a real browser at `/tv` because Google blocks
    sign-in inside embedded WebViews (`README.md:34`), and the phone polls `POST /api/tv/pair/poll` for the
    signed token;
  - `MainActivity.kt`'s WebView settings (no file or content access, mixed content never allowed) for
    showing the cockpit. They harden the WebView only, not the transport (`MainActivity.kt:85-91`);
  - ADR-044 Phase 4's phone-as-node role, for location only (D7).

  What it changes from the Fire TV project, whose settings do not fit a phone that carries an evidence
  credential:
  - `android:allowBackup="false"`, or backup rules that exclude the credential preferences. The TV app sets it
    true (`AndroidManifest.xml:14`), so its preferences go into device backups and restore onto another
    handset, and the credential would not stay confined to one device;
  - cleartext off, with https-only host validation in the settings screen. The TV app permits cleartext
    (`AndroidManifest.xml:21`; `network_security_config.xml:6`) for a LAN host
    (`network_security_config.xml:2-4`), and a phone on public Wi-Fi would send its bearer token and fixes
    over http;
  - the credentials kept in Android Keystore-backed storage, not in plain `SharedPreferences` as the TV
    token is (`Config.kt:86-88,100-101`). ADR-044 names "secure credential storage" (ADR-044:56).

  What it adds:
  - a foreground service of type `location` that reports fixes, with an update interval under 60 s at least
    while the phone is within a set distance of an armed place. Without one, a backgrounded app receives
    location only a few times an hour on Android 8 and later, and D4 counts a fix only within 120 s of
    receipt and needs two fixes at least 30 s apart for an enter;
  - the permissions `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`,
    `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` and `POST_NOTIFICATIONS`, with
    `foregroundServiceType="location"` on the service, as target SDK 34 requires. The Fire TV manifest
    declares only `INTERNET` and `ACCESS_NETWORK_STATE` (`AndroidManifest.xml:4-5`);
  - the mock-location flag on every fix: `Location.isMock()` on API 31 and later, `isFromMockProvider()` on
    API 18-30. Ingest records it in the evidence provenance, and a mock fix never qualifies a risk-increasing
    transition (D4);
  - the location device credential (D3). The pairing token is a user-session credential:
    `createTvTokenAuthMiddleware` injects the paired user as an authenticated session
    (`src/app/routes/tv-pairing-routes.ts:222-249`), so it is never the ingest credential. The phone does not
    use `/api/join/enroll`. It requests a location enrolment and shows a code; the person approves it in the
    Settings Location tab in a real browser with the step-up proof (D3); the enrolment route mints the device
    id and the credential in one transaction, and the phone polls for them, the ADR-068 device-grant shape.
    It posts every fix to `POST /api/location/devices/:deviceId/presence`. Its `location_devices` row is
    `device_kind = 'phone'`, owned by the approving person; its fixes carry source `android`.

  Done when:
  - after `gradle wrapper --gradle-version 8.2` (or with the wrapper committed), `./gradlew assembleDebug`
    builds the APK, and `./gradlew testDebugUnitTest` passes Robolectric tests for the reporter's settings
    and the enrolment round trip;
  - a manifest or Robolectric assertion proves the location permissions and the `location` foreground-service
    type are declared, and that backup and cleartext are off;
  - nothing is reported until the person turns reporting on in the app and grants the OS permission, and the
    device's `location_devices` row has `reporting_enabled` (D6);
  - specs prove the ingest route refuses the pairing token, a credential for a different device id, a
    node-bound token for the same id, a token minted by a different account for the same id, and a request
    after the credential is revoked in `/api/cli-tokens`; and that the location credential is refused on
    `/api/remote-clients/register`;
  - a fix flagged as mock is stored with its flag and never qualifies a risk-increasing transition;
  - on an Android emulator with the app in the background and the screen off, two fixes from a simulated
    route received 30-120 s apart qualify an enter, move `location_current`, and fire an L8 rule armed
    against the phone as its enrolled device;
  - the ADR-044 security review of the phone ingress (ADR-044:102-104) is complete before live acceptance.

  Live acceptance on a physical Android phone is the operator's external step.
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
  `102-cli-token-node-binding.sql`, `115-durable-remote-task-journal.sql`,
  `145-app-access-principal-issuer.sql`; ADR-042, ADR-076, ADR-114, ADR-124.
- Phone node: `packages/oshal-firetv/` (README, `app/build.gradle`, `AndroidManifest.xml`, `Config.kt`,
  `Net.kt`, `PairingActivity.kt`, `MainActivity.kt`); `src/app/routes/tv-pairing-routes.ts`;
  `src/app/routes/join-routes.ts`; ADR-044, ADR-068.
- Triggers and delivery: `src/features/scheduling/`; `src/app/home-schedule-dispatch.ts`;
  `src/app/trading-event-alerts.ts`; `src/app/routes/notify-routes.ts`; `src/features/notifications/`;
  `src/shared/package-tools/index.ts`; ADR-079, ADR-125, ADR-140.
- Spatial: `src/features/spatial-mapping/`; `src/features/drone/`; `store/drone/`, `store/spaces/`,
  `store/embodied/`; ADR-111.
- Privacy: `src/features/data-lifecycle/`; `src/features/governance/audit/audit-capture-middleware.ts`;
  `src/shared/logger/logger.ts`; `src/shared/middleware/guest-capability-matrix.ts`;
  `tests/unit/machine-write-identity.spec.ts`; ADR-100, ADR-105, ADR-122.
