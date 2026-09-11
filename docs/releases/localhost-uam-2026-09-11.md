# Localhost Users and Access acceptance — 2026-09-11

The operator requested acceptance on the running local deployment after the source checks in
[the remote authorization record](remote-authorization-2026-09-11.md). The initial API container
ran an older compiled server without the application authorization routes; updated bind-mounted
pages did not establish backend deployment.

## Acceptance scope

Probe the server at `http://localhost:35457`. For authenticated browser acceptance, explicitly
select an origin supported by the existing OIDC configuration and the exact deployed image commit.
Verify the reported image commit, normal schema bootstrap, Users/current role state, Access catalog,
effective rights, scoped audit and the registered read-only Lab probe. Do not claim root, create
accounts or change grants as part of this acceptance.

The initial database had no assigned swarm roles. Operator access comes from the existing configured
allowlist; an unclaimed root does not mean that administrators are absent. The migration ledger
initially ran through 126, leaving only 127–133 pending. The previous image and a verified database backup were
preserved before the local update.

## Installation and interface corrections

The local API now receives the same `BOT_DATABASE_URL` input as workers so its pre-start database-role
provisioner can validate and provision the intended runtime roles. The managed PostgreSQL overlay
continues to remove that credential from the long-running API and confines it to the initializer.
The existing bot database regression suite is included in the fixed authorization command and Lab
registration.

The first updated startup exposed an existing local PostgreSQL membership mismatch: roles created
by a superuser lacked the ADMIN membership option required by the strict provisioner. Provisioning
now establishes that option only for a superuser bootstrap. Managed non-superuser creators keep
their existing path, and the verifier still rejects unexpected memberships. A disposable PostgreSQL
16 suite covers repeated local repair, repeated managed provisioning and refusal of a foreign
membership with worker login disabled; it is registered with the authorization foundation tests.

The full final-phase check also exposed a legacy excess sequence default and an unsupported
`MAINTAIN` privilege query on PostgreSQL 16. Provisioning now resets app table/sequence defaults
before granting the exact allowed rights. The verifier checks `MAINTAIN` on PostgreSQL 17 and
later while retaining all PostgreSQL 16 privilege checks. The registered disposable PostgreSQL
suite exercises full final provisioning twice, future-object defaults and worker column boundaries.

Users now shows current administrator access separately from root ownership, including access from
the configured operator allowlist when no role row exists. The page uses shared theme tokens for
text, cards, inputs and buttons so its status remains readable in the selected theme. It does not
claim root or change the caller's authority automatically.

The dedicated browser acceptance is `tests/live/authorization-management.live.spec.ts`, registered
separately as `authorization-localhost-live`. It uses the existing browser through the no-prune CDP
fixture and requires an explicitly selected HTTP loopback or HTTPS installation origin plus the
full expected image commit. It does not start a mock server or
fabricate authentication. Its Lab button reports the browser prerequisite; the existing
`authorization-management` probe remains a read-only catalog request.

This installation's configured OIDC origins do not include localhost. Login on an unlisted host
falls back to the configured application origin; a hosted login does not authenticate localhost.
The signed-in test can use the existing HTTPS tunnel origin after confirming it reaches the
local installation. No login-provider configuration or account changes are needed for that path.

See [live test instructions](../../tests/live/README.md#installed-users-and-access-acceptance).

## Observed installation results

The local instance runs committed build `980b2561872334e052164d6e8fb17993ab44ef9c`, image
`sha256:cd92d6b2e59a56668613d521c890e4c3aaea6d1ff43689f444eaef9ebc46335b`.
The image was built from a Git archive, and its commit label, native SQLite and kernel-skill probes
passed. The previous image remains tagged for rollback. A custom-format database dump passed
`pg_restore --list`, and the local backup copy matched its source length.

Normal API startup now completes final runtime-role provisioning successfully. Migrations 127–133
are present; the final boot reports zero pending migrations. The eight new authorization/principal
tables checked have forced row-level security. All 75 application packages loaded without a failure.
The API and all 34 workers run the same image and report healthy; all 14 pre-existing infrastructure
containers retain their IDs and remain running. Health briefly timed out during worker startup,
then recovered; three consecutive post-startup localhost probes returned HTTP 200.

Localhost and the configured HTTPS origin report the same full build commit. The tunnel's ingress
configuration maps that HTTPS hostname to the local API service. Anonymous authorization, swarm-role
status and Test Lab catalog requests return HTTP 401. The eleven saved authentication/configuration
fingerprints are unchanged. No swarm role was assigned, root was not claimed, and application
assignments and policy revision remain zero. Existing provider identities are observed through
normal verified requests; these counts are not an external directory enumeration.

The running compiled Lab catalog contains 23 authorization regression-suite references, including
the PostgreSQL upgrade suite, and the separate browser acceptance reference. Validation records:

| Check | Result |
|---|---|
| Users browser, authorization routes and compose credential regressions | 27 passed across 3 files |
| Updated authorization registration/parity suite | 10 passed |
| PostgreSQL 16 provisioning, full final phase, repeat startup and legacy ACL repair | 4 passed |
| Selected existing managed-role contract checks | 6 passed; unrelated/gated cases were not run |
| Committed-source publication gate and exported HEAD typecheck | Passed |
| Live browser harness discovery, strict TypeScript and scoped lint | Passed; discovery is not execution |

Authenticated browser acceptance remains **pending**. Automatic approval review rejected the Chrome
launch with "blocked by policy"; the operator was asked to open the existing test profile and sign
in at the configured HTTPS origin. No authenticated browser result or executed Lab probe is claimed.
The PR still requires independent review before merging to main. No GitHub Actions were invoked.
