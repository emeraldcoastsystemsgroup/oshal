# Localhost Users and Access acceptance — 2026-09-11

The operator requested acceptance on the running local deployment after the source checks in
[the remote authorization record](remote-authorization-2026-09-11.md). The initial API container
ran an older compiled server without the application authorization routes; updated bind-mounted
pages did not establish backend deployment.

## Acceptance scope

Use `http://localhost:35457`, the existing OIDC configuration and an authenticated operator browser.
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

Users now shows current administrator access separately from root ownership, including access from
the configured operator allowlist when no role row exists. The page uses shared theme tokens for
text, cards, inputs and buttons so its status remains readable in the selected theme. It does not
claim root or change the caller's authority automatically.

The dedicated browser acceptance is `tests/live/authorization-management.live.spec.ts`, registered
separately as `authorization-localhost-live`. It uses the existing browser through the no-prune CDP
fixture and requires an explicitly selected localhost origin. It does not start a mock server or
fabricate authentication. Its Lab button reports the browser prerequisite; the existing
`authorization-management` probe remains a read-only catalog request.

See [live test instructions](../../tests/live/README.md#localhost-users-and-access-acceptance).
Deployment and signed-in results will be recorded after the actual run; source test success alone
does not establish localhost acceptance.
