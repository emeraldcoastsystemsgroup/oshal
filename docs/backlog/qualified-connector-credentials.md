# Qualified connector credentials: foundation and integration contract

Status: **Foundation and bounded broker/session source; not activated.** Personal
credentials only. This candidate supplies no qualified HTTP route, fresh-grant API,
OAuth ceremony or Home integration. Those are separate coordinated slices. Every
L8 physical-readiness hold remains in place. No PostgreSQL or provider acceptance
is claimed; migration promotion remains blocked on real enforcing-role proof.

## Why an additive namespace

Existing connector rows and DEKs identify their owner by subject alone. A verified
LOCAL caller, a matching email, or absence of a visible directory collision cannot
establish the issuer of a legacy row. The existing stores and all of their readers
are left unchanged; no row/key is copied, adopted, backfilled or relabelled.

This is a bounded prerequisite of the current [credential ownership and execution
actor backlog](../BACKLOG.md#credential-ownership-and-execution-actor-are-explicit-in-connector-and-jarvis-metadata),
not closure of that item or of L8.

## Schema contract

[Migration 181](../../scripts/migrations/181-qualified-connector-credentials.sql)
adds only:

- `oshal_qualified_deks`: exact `(principal_issuer, owner_sub)` primary key,
  wrapped random 32-byte DEK and creation timestamp.
- `oshal_qualified_connections`: UUID, exact owner tuple, provider, account key,
  status, revision, encrypted access/refresh tokens, expiry and timestamps. The
  personal account uniqueness tuple includes issuer/sub/provider/account. Its owner
  references the qualified DEK tuple. There is no tenant or grantor fallback.

Identity columns use deterministic `C` collation. Both tables ENABLE and FORCE RLS,
matching `oshal.current_issuer` and `oshal.current_sub` with no operator branch.
PUBLIC gets no table privileges; the migration grants the app role, not the bot.
The ordinary connection trigger is not SECURITY DEFINER: identity/account fields
are immutable and every update advances the database-owned revision. A later broker
must use compare-and-set revisions; a successful encrypt does not persist a token.
Deleting connections before their referenced DEK is a later owner-erasure concern.

No existing table, crypto format, provider behavior, helper allowlist, or default
connection-selection rule is changed. Migration 181 was unused on fetched main
`58287d3816639b2b913eb5b4574adce57e34ca37` when this scope was claimed.

## Primitive API

[connector-qualified-token-crypto.ts](../../src/app/routes/connector-qualified-token-crypto.ts)
exports:

```ts
interface QualifiedConnectorPrincipal {
  readonly sub: string;
  readonly principalIssuer: string;
}
interface QualifiedConnectorQueryable {
  query(text: string, values?: unknown[]):
    Promise<{ rows: Array<Record<string, unknown>> }>;
}
encryptQualifiedConnectorToken(db, principal, plaintext): Promise<string>;
decryptQualifiedConnectorToken(db, principal, ciphertext): Promise<string>;
```

The caller authenticates the exact principal and supplies an already-bound client
or query port. The primitive neither stamps identity nor opens/commits transactions.
Use one caller-owned transaction for key creation plus connection persistence.
Reject blank, padded, control-bearing, oversized and invalid-Unicode identities;
do not trim, lowercase, normalize URLs or otherwise canonicalize them. The function
snapshots identity before awaiting database work.

The only token format is `qct1:<nonce>:<tag>:<ciphertext>`; the only DEK wrapper is
`qdk1:<nonce>:<tag>:<ciphertext>`. Parts are canonical base64, with a 12-byte nonce,
16-byte GCM tag, 32-byte DEK, and 1–65536-byte UTF-8 token payload. AES-256-GCM AAD is
the UTF-8 JSON array `["oshal:qualified-connector",1,purpose,issuer,sub]`, with
different `token`/`dek` purposes. Token AAD binds the principal, not a connection
UUID or access-versus-refresh field; the future broker must select and validate the
exact trusted row/field, not accept an arbitrary supplied ciphertext.

The mandatory `SESSION_SECRET` feeds HKDF-SHA256 with salt
`oshal:qualified-connector:kek:salt:v1` and info
`oshal:qualified-connector:kek:wrap:v1`. There is no legacy key, legacy decrypt,
envelope-disable flag, shared-key fallback or implicit recovery. Random DEKs are
created only on encryption, using insert-on-conflict then re-reading the winning
key. Decryption of a missing/invisible/corrupt key fails without writes. Unknown
formats and authentication failures fail closed. Raw SQL/crypto errors, principal
values and credentials are not included in the outward error or diagnostic.

KEK rotation/recovery is not implemented: changing the secret does not adopt or
repair keys. That remains separate governed work; never recover by minting a key
for existing ciphertext.

## Shared personal transaction boundary

[connector-qualified-session.ts](../../src/app/routes/connector-qualified-session.ts)
exports `withQualifiedConnectorSession(db, principal, work, { signal? })`. The pool
must be the existing request-bound GUC pool, not an ambient transaction or raw/system
pool. Existing request ALS must match the exact issuer/sub and `isOperator === false`;
the helper does not establish identity or trust a request/header claim. Authenticated
HTTP integration owns any explicit same-verified-principal operator downgrade.

The helper takes a dedicated GUC client and runs short database-only work in a
`READ COMMITTED` transaction. No provider requests or nested commit/rollback belong
in its callback. It rechecks context after awaits, rolls back failures with a bounded
one-second cleanup attempt, and physically ends suspect concrete `pg.Client`s before
wrapped release. Release alone can queue RESET behind unresolved SQL. Cancellation
rejects the waiting caller, prevents late continuation, disposes an acquired client,
and discards a late checkout before callback admission. Successful release retains
the existing GUC wrapper's reset-before-reuse behavior.

Lifecycle errors have fixed codes without driver diagnostics. Callback business
errors are rethrown after cleanup for caller-owned classification; callers must not
serialize arbitrary callback error messages. A failed/aborted commit acknowledgment
may have committed: do not assume rollback reversed it or automatically retry a
fresh grant/provider operation. Re-read authoritative metadata through its normal
authenticated path before deciding what happened.

## Strict qualified personal broker

[connector-qualified-broker.ts](../../src/app/routes/connector-qualified-broker.ts)
exports `resolveQualifiedPersonalCredential(db, principal, selection, options)`:

```ts
selection = { connectionId, provider, expectedRevision }; // revision: exact BIGINT string
options = { refresh?, signal? }; // trusted server adapter, never request input
result = { accessToken, connectionId, provider, revision, expiresAt };
```

The result is controller-only plaintext for one fixed operation, never an HTTP,
model, CLI or workspace payload. Selection requires an exact lowercase UUID,
provider and canonical positive revision string, with exact matching non-operator
request identity. Queries use only qualified personal tables and match issuer,
subject, UUID, provider, revision and connected status. No default-account, legacy,
environment, directory, LOCAL, operator or household fallback exists.

Finite expiry must remain in the future; null explicitly means no recorded expiry.
Expired rows require a qualified refresh token and an injected refresh adapter.
There is no live provider implementation here. Adapter input binds the same owner,
UUID/provider/revision; output requires nonempty bounded tokens and canonical future
UTC expiry. Omitted refresh rotation retains only that exact qualified row's token.
Unknown/legacy formats, missing keys, malformed expiry, stale selection, storage
failure and refresh failure are fixed-code refusals, not credential fallbacks.

Refresh happens **outside** a transaction. Decryption and provider settlement are
followed by fresh row checks. Only then does the shared session lock the exact row,
encrypt the refreshed values, compare-and-set the original revision and credential
snapshot, require the database's next revision and acknowledge commit. A fresh
post-commit check catches revocation/replacement before returning plaintext. Failed
CAS, revocation, replacement and abort never retry the provider automatically.
Creation and expiry equality use separate database-formatted UTC witnesses with
all six fractional digits, selected as text so the default `pg` Date decoder cannot
truncate them. The same exact witnesses participate in post-await snapshot checks
and the timestamp CAS; the database column is never rounded for comparison. Public
expiry metadata still uses millisecond ISO format. This distinction prevents an
unchanged microsecond row from losing an already-rotated provider result to a false
CAS failure, while retaining detection of same-millisecond delete/reinsert changes.
Hung refresh can be abandoned using the supplied abort signal; late results cannot
persist. Token resolution establishes a revalidation point, not execution authority
after additional caller awaits: Home must retain its own final authorization checks.

## Verification boundaries

- [Focused crypto suite](../../tests/unit/connector-qualified-token-crypto.spec.ts):
  real Node crypto, SQL-map and logger doubles. Covers exact issuer distinction,
  purpose/identity AAD, nonce/key behavior, first-use races, mutable caller identity,
  malformed/corrupt/legacy formats, absent secrets/keys and storage-failure refusal.
  Its migration assertions are source checks, not RLS proof.
- [PostgreSQL companion](../../tests/unit/connector-qualified-credentials-postgres.spec.ts):
  **prepared, not executed**. Uses the existing disposable server, migrations and
  NOSUPERUSER/NOBYPASSRLS runtime role owning FORCE-RLS tables. Intended evidence:
  same-sub issuers coexist without cross-reads/writes, operator flag cannot widen,
  revisions/immutability, races/rollback and mixed legacy rows unchanged/readable
  through their original codec. It never targets an inherited DSN.
- [Broker suite](../../tests/unit/connector-qualified-broker.spec.ts): actual broker,
  crypto and request ALS; explicit SQL/transaction/provider doubles. Covers exact
  selection, missing provenance, stale/revoked/replaced rows during decryption and
  refresh, expiry, CAS refusal, abort and sanitized errors. Real-source negative
  controls remove access-decrypt, refresh-admission and post-commit revalidation;
  each must fail its intended assertion before byte-identical restoration.
- [Broker PostgreSQL companion](../../tests/unit/connector-qualified-broker-postgres.spec.ts):
  **prepared, not executed**. Runs the actual migration, enforcing table-owner role,
  `pg` timestamp decoder, GUC/session wrappers, crypto and broker. Only the refresh
  provider is doubled. Explicit six-digit creation/expiry rows demonstrate the old
  Date equality failure, successful persisted refresh/rotation, same-millisecond
  delete/reinsert refusal, actual revocation/replacement and same-sub cross-issuer
  isolation. Unit timestamp/CAS doubles are not substitutes for this boundary run.
- [Session suite](../../tests/unit/connector-qualified-session.spec.ts): actual ALS
  and GUC wrapper against a named SQL client double, plus installed `pg` pool/client
  and GUC/DDL wrappers over an in-memory held transport. It proves physical
  end-before-release eviction, queued RESET rejection, bounded rollback, late
  checkout and reset-before-reuse, without a network socket or PostgreSQL server.
  Removing physical `end()` must fail the transport-destroyed assertion. This is
  pool/protocol lifecycle evidence, **not SQL, locking or RLS proof**.

The authorized local command selects only the three non-PostgreSQL files with a 128 MiB runner and
one 384 MiB worker. The handover supervisor requires fresh free RAM of at least
1800 MiB, monitors a 600 MiB reserve and imposes a 180-second process deadline:

```sh
node --max-old-space-size=128 node_modules/vitest/vitest.mjs run --config vitest.config.ts --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384 --testTimeout=15000 --hookTimeout=15000 tests/unit/connector-qualified-token-crypto.spec.ts tests/unit/connector-qualified-broker.spec.ts tests/unit/connector-qualified-session.spec.ts
```

Actual run receipts/hashes belong to the local handover; gates are tied to their
exact heads, never inherited by a later broker/session increment. No migration
execution or deployed acceptance is implied here.
Docs index and Test Lab registration belong to the separately coordinated
integration, outside this exact foundation scope.

## Remaining before a physical Home handler may become ready

1. Authenticated fresh-connect/reconnect/token submission binds issuer **and** sub
   throughout initiation/completion. Explicitly distinguish qualified from legacy
   status; never coalesce an ambiguous legacy refresh token into a new grant.
2. Independently review and integrate the bounded broker/session at authenticated
   server operation boundaries, including current permission checks. Supply only
   trusted refresh adapters and exact selections; the source primitive does not
   establish HTTP/operation authority or an end-to-end fresh-connect contract.
   No legacy, household, environment, directory-collision or LOCAL-only shortcut.
3. Home consumes that broker and retains fire authorization, deadline/abort,
   connection-replacement/refusal guards and no-retry behavior. Only then may
   independently reviewed server-owned readiness change for the supported scope.
4. Run the real enforcing-role migration/upgrade regressions and fresh-grant/broker
   protocol tests in coordinated slots. Provider acceptance is separately labelled.
   Shared/household grants require additional issuer-qualified use authority.

This candidate supplies no default-account selector, authenticated endpoint,
physical operation, live provider implementation or new application permission.
No full Home/L8 completion.
