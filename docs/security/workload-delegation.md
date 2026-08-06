# Workload-to-API user delegation

SEC-01 replaces the fleet-wide service secret as a user identity on the owner-scoped Graph and
Jarvis APIs. A controller-signed bearer token delegates one user's authority to one registered
workload for one exact HTTP request. PostgreSQL records the grant before release and consumes its
`jti` atomically before route code runs.

This is separate from [controller-to-bot HTTP delegation](./http-delegation.md). That control
authorizes `POST /api/swarm-execute` on a bot. This control authorizes a bot or automation workload
to call selected user-data routes on the controller API.

## Current rollout status

The migration, hash-only PostgreSQL store, issuer, verifier, Graph/Jarvis middleware, route policy,
configuration, deterministic adversarial suite, and mandatory real-PostgreSQL proof are present in
the repository. `OSHAL_WORKLOAD_DELEGATION_MODE` still defaults to `legacy`; that is intentional so
a code deploy cannot silently strand callers that still use `X-Service-Secret`.

Do not report operational closure until all of the following are recorded against the deployed
commit: migration 119 applied, workload identities provisioned, callers converted to bearer
delegations, a clean shadow observation, enforce-mode canary, shared-secret rotation, and the
required PostgreSQL proof. The test does not skip when its database is unavailable.

## Authority model

Migration `scripts/migrations/119-workload-delegation-authority.sql` creates two forced-RLS tables:

- `oshal_workload_identities` holds workload kind, allowed scopes, lifecycle, expiry, active key id,
  the SHA-256 digest of a random 256-bit credential, and one bounded previous-key overlap. It never
  stores or returns plaintext credentials.
- `oshal_user_delegations` holds the immutable signed tuple: `jti`, workload, subject and verified
  issuer, ticket or run, method, path, request-body digest, scopes, issue/not-before/expiry times,
  revocation, and consumption.

Only a short transaction marked `oshal.workload_delegation_broker=on` can see or mutate these
tables. Both tables use `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. Delegation rows
cannot be deleted or have signed fields rewritten; revocation and consumption are irreversible.
Migration 119 explicitly revokes the `oshal_bot` role's inherited future-table grants, so a bot
cannot read or modify the authority even if it sets the application-defined broker GUC itself.

The signed token contains:

| Claim | Binding |
| --- | --- |
| `iss` | Controller issuer, normally `urn:oshal:controller` |
| `aud` | Exact API audience, normally `urn:oshal:api` |
| `sub` | Authenticated user subject |
| `principal_iss` | Verified identity-provider namespace for `sub` |
| `azp` | Registered workload id |
| `task_id` | Exact durable ticket id or run id |
| `method`, `path` | Exact canonical request method and path |
| `body_sha256` | Canonical SHA-256 of the complete JSON body, including `null` on bodyless requests |
| `scope` | Code-owned route scope; callers cannot choose a weaker route classification |
| `iat`, `nbf`, `exp` | Fifteen-to-thirty-minute lifetime, capped by parent-dispatch expiry |
| `jti` | Random grant id consumed once under a PostgreSQL row lock |

The API accepts the token only in `Authorization: Bearer <token>`. It does not read a workload
identity or victim subject from `X-OSHAL-User-Sub`. After signature, audience, time, route, body,
scope, durable binding, lifecycle, revocation, and replay checks pass, the request database context
is stamped from signed `sub` and `principal_iss` with `isOperator=false`.

## Delegated route matrix

Unlisted routes remain on ordinary OIDC/PAT authentication. The fleet secret may remain on
non-user registration, health, and heartbeat routes during migration, but enforce mode refuses it
on every route below.

| Scope | Method and routes |
| --- | --- |
| `graph:read` | `POST /api/graph/query`; `GET /api/graph/neighbors`; `GET /api/graph/path` |
| `graph:write` | `POST /api/graph/nodes`; `POST /api/graph/edges` |
| `jarvis:read` | `GET /api/jarvis/history`; `/tasks`; `/overview`; `/ask/result`; `/ask/jobs`; `/visuals/:artifactId` |
| `jarvis:write` | `POST /api/jarvis/tasks/:id/delivered`; `/ask`; `/thread/close`; `/ask/dismiss` |

Paths are canonicalized before policy lookup. Query strings are excluded from the route binding,
while the body is separately bound. Controls, fragments, duplicate separators, dot segments,
encoded slash/backslash, malformed escapes, and unlisted method/path combinations fail closed.

## Configuration

| Variable | Process | Constraint |
| --- | --- | --- |
| `OSHAL_WORKLOAD_DELEGATION_MODE` | Controller API | `legacy`, `shadow`, or `enforce`; default `legacy`; an unknown value becomes `enforce` |
| `OSHAL_WORKLOAD_DELEGATION_PUBLIC_KEYS` | Controller API | Ed25519 public JWK/PEM rotation ring used only to verify workload-to-API tokens |
| `OSHAL_WORKLOAD_DELEGATION_AUDIENCE` | Issuer and API | Exact audience; default `urn:oshal:api` |
| `OSHAL_WORKLOAD_DELEGATION_TTL_SECONDS` | Issuer | Integer 900-1800; default 900 |
| `OSHAL_DELEGATION_SIGNING_KID` | Controller signer | Active key id; paired with the private key |
| `OSHAL_DELEGATION_SIGNING_PRIVATE_KEY` | Controller signer only | Ed25519 private JWK/PEM; never injected into a bot |
| `OSHAL_DELEGATION_ISSUER` | Issuer and API | Exact issuer; default `urn:oshal:controller` |
| `OSHAL_DELEGATION_CLOCK_SKEW_SECONDS` | API verifier | Existing bounded verifier skew |

The local compose file places the workload public ring only in `oshal-api`. It does not add the
controller private key to the shared bot environment. Keep the same separation in Kubernetes or
other deployment manifests.

## Provision and rotate workload credentials

Generate credentials with `generateWorkloadCredential()`. It returns an `oshal_wk_` bearer secret
containing 32 random bytes and an independent non-secret key id. Show the plaintext exactly once,
store it only in the owning workload's secret manager, and pass it to
`PostgresWorkloadDelegationStore.registerWorkload`; the store hashes it before SQL.

Rotation is compare-and-set and overlap-first:

1. Generate a new credential and key id.
2. Call `rotateWorkloadCredential` with the expected current key id and a
   `previousValidUntil` no more than 24 hours after `rotatedAt`.
3. Install the new plaintext in the workload and verify authentication with its required scopes.
4. During the explicit overlap, both current and previous keys authenticate; after the timestamp,
   the previous credential fails without a cleanup job.
5. Remove the retired secret from the workload secret manager. Never copy it into a ticket, log,
   shell history, database column, or documentation.

If a workload credential or signing key is suspected compromised, suspend/revoke the workload or
remove its allowed scopes in a broker-controlled administrative transaction, revoke outstanding
delegation JTIs, replace the credential/key, and accept fail-closed interruption. Do not extend an
overlap for a compromised key.

## Rollout

1. Apply migration 119 using the bootstrap/migration identity. Confirm the runtime role is
   `NOSUPERUSER` and `NOBYPASSRLS` and has only the required DML grants.
2. Run `tests/workload-delegation-rls-live.spec.ts` against that PostgreSQL boundary. It proves
   hash-only storage, forced RLS, immutable rows, overlap rotation, signed identity derivation,
   concurrent replay exclusion, wrong binding, expiry, revocation, workload lifecycle, and scopes.
3. Register each caller with only the scopes it needs. Inventory the old
   `X-Service-Secret` + `X-OSHAL-User-Sub` calls and give every one a named owner.
4. Set mode to `shadow`. Ordinary OIDC/PAT remains authoritative. Valid bearer delegations execute;
   legacy fleet-secret traffic continues but logs route/posture telemetry.
5. Observe at least 48 hours. Require zero legacy calls on the delegated route matrix and exercise
   wrong audience, expired token, victim header, route escalation, revocation, and concurrent replay.
6. Canary one controller replica in `enforce`. A fleet-secret-only call to a delegated user route
   must return `403 {"error":"legacy_service_identity_not_allowed"}`; no route code or database
   query may run. OIDC/PAT and valid bearer delegations must remain healthy.
7. Expand enforcement, rotate the fleet secret, and remove that secret from user-data callers.
   Retain it only on reviewed non-user registration/heartbeat routes until their own migration.
8. Record commit SHA, migration output, test output, shadow/canary window, rotation evidence, and
   rollback owner in the protected change and issue tracker.

## Failure behavior

- Invalid signature, audience, lifetime, route/body binding, missing/revoked/expired grant: 401.
- Replayed `jti`: 409.
- Inactive workload, durable binding mismatch, or insufficient current scope: 403.
- Database/verifier infrastructure failure: 503; route code does not run.
- Fleet secret on a delegated user route in enforce mode: 403
  `legacy_service_identity_not_allowed`.

Logs contain bounded method, route template, workload id, outcome, and duration. They must never
contain bearer tokens, static credentials, private keys, raw nonces, request bodies, or user data.

## Rollback

Change `enforce` to `shadow` only as a time-bounded incident rollback; this restores legacy caller
compatibility and is a security downgrade. Do not drop migration 119 or delete authority history.
Keep accepting valid bearer delegations during rollback, diagnose the failing caller, and return to
enforce after the legacy-call counter is zero. If verifier key material is wrong, restore the last
known-good public ring rather than disabling signature checks for presented tokens.

Migration 119 is additive. Its database rollback is to stop issuing/accepting new delegations and
retain the tables for audit; destructive removal requires a separately reviewed migration after
retention and incident obligations are satisfied.
