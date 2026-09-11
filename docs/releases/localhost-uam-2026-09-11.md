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

The initial database has no assigned swarm roles. Operator access comes from the existing configured
allowlist; an unclaimed root does not mean that administrators are absent. Existing migrations run
through 126, leaving only 127–133 pending. Preserve the running image and back up the database before
the local update.

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
Deployment and signed-in results will be recorded after the actual run; source test success alone
does not establish localhost acceptance.
