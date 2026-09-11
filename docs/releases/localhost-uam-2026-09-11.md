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

## Initial installation results

The initial acceptance used committed build `980b2561872334e052164d6e8fb17993ab44ef9c`, image
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

That initial attempt did not complete authenticated browser acceptance: automatic approval review
rejected a Chrome launch with "blocked by policy". The subsequent acceptance below used the already
open signed-in browser. No browser launch or authentication bypass was needed.

## Follow-up acceptance

The follow-up local build is `8d42856d133d68ad9d26482ac2491267d80974ad`, image
`sha256:83c339cba74bbd2c3fe048562cc2aee202a156eda1cd5fe79513321637b80948`.
It was built from an LF-preserving committed archive. Native SQLite and the installed Access HTML
asset passed the image probes. All 35 application services are healthy on this image. All 14 existing
infrastructure containers and the 11 reviewed authentication/configuration fingerprints are unchanged.
Localhost and the configured HTTPS origin report the same full commit.

Manual acceptance in the existing signed-in browser verified Users, the exact provider account,
administrator access from the allowlist, unclaimed root ownership, and the dynamic Access catalog.
The Access page's compiled route initially looked for a nonexistent `dist/pages` asset. Commit
`924d9e4dd5ea8b0e1dacbf215ae6f08b06d4c07e` fixes the installed asset path and sanitizes missing-file
responses; its 12 registered route regressions pass, including a real compiled-route fixture.
The browser then displayed the current user and imported application roles without a temporary copy.

An authenticated browser GET of `/api/test-lab/catalog` displayed the authorization scenarios and
installed test registrations. That is catalog visibility proof, not execution of every Lab scenario.
The separate CDP live harness was not executed. The read-only stack verifier reports its own
`authenticatedLabVerified: false` because no credential was supplied to that script; the manual
authenticated browser observation is recorded separately.

The root entrypoint now retains a valid explicit `/?app=<name>` selector when redirecting into the
cockpit. Fourteen focused-entry and platform-registration checks pass. The focused-entry regression
is registered in the AI Test Lab. Invalid or ambiguous selectors retain the existing host default.

No account, swarm role, application assignment or root ownership was changed. Catalog-bearing
applications enforce their imported permissions; the reviewed compatibility mode remains in effect
for packages without catalogs. External directory synchronization is not claimed by these checks.
The PR still requires independent review before merging to main. No GitHub Actions were invoked.

The subsequent business-navigation build is `71135bb770ed2e8897e60c522a085eb9526842ed`, image
`sha256:8273a7f6695aa386b82076484c5dd68177968836407fa23906c3239138476672`.
All 35 application services again pass health and image parity; the 14 infrastructure containers,
11 configuration fingerprints and existing privilege state remain unchanged. The 18-test registered
runtime suite passes, including business-only document selection, current membership revocation,
explicit denial and a reload during authorization. The publication gate and committed-HEAD
typecheck pass. Browser fixture acceptance verifies actual package pages and protected downloads
for personal and business workspaces; that isolated proof does not change installed user grants.

## Installed application acceptance

The subsequent application upgrade used the ordinary recursive store installer and the existing
package deployment helper. All four dependency packages resolved to one committed store revision.
The shared schema was installed first, followed by the dependent application. Normal startup
loaded all 76 packages with zero failures. A read-only database and installation probe passed
197 checks, including the migration ledger, active versions, registered runner paths and forced
row-level security. An early probe during startup was retained separately and is not a passing
result. The post-startup probe passed without applying manual SQL or changing user grants.

The installed copy's 356 tracked source files match their committed Git blobs byte for byte.
Twenty-four existing generated documents/cache files were retained and inventoried separately;
they are not claimed to be Git-verified source. Final stack verification again passed for all
35 application services, 14 unchanged infrastructure containers, 11 configuration fingerprints
and the existing privilege state. The deployment parity command passed.

In the existing signed-in browser, Users displayed the current administrator and identity roster;
Access displayed the newly installed application version and imported roles. Default Home showed
the application's card, and its explicit root selector opened its own focused theme and navigation.
The current account has no application business role, so the embedded data route correctly denied
access. Root ownership is not required to administer the role assignment. No account, role,
business record or provider connection was created for these checks.

An authenticated GET of the installed Test Lab catalog displayed the upgraded application cases
and their exact package version, file references and pending runner prerequisites. This is live
registration proof; isolated regression execution is reported separately. The browser prerequisite
and caller-owned credential requirement were not bypassed to turn pending cases into successes.

The denied embedded page initially displayed a JSON error. A final core correction returns static
role guidance only for browser navigation to an exact read-only `app.open` binding. APIs and tools
retain JSON errors, and the package handler never runs for denied requests. The registered runtime
suite now passes 22 cases, including escaped application labels, script-free CSP, administrator
guidance, unchanged assignments and membership revocation.
