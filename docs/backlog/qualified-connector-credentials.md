# Qualified connector credentials: foundation and integration contract

Status: **Foundation source only; not activated.** Personal credentials only. No
qualified connection route, OAuth ceremony, broker or Home integration is provided
by this slice. Every L8 physical-readiness hold remains in place. No PostgreSQL or
provider acceptance is claimed.

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

The authorized local command selects only the first file with a 128 MiB runner and
one 384 MiB worker. The handover supervisor requires fresh free RAM of at least
1800 MiB, monitors a 600 MiB reserve and imposes a 180-second process deadline:

```sh
node --max-old-space-size=128 node_modules/vitest/vitest.mjs run --config vitest.config.ts --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384 --testTimeout=15000 --hookTimeout=15000 tests/unit/connector-qualified-token-crypto.spec.ts
```

Actual run receipts/hashes belong to the local handover. No full typecheck,
committed-head gate, migration execution or deployed acceptance is implied here.
Docs index and Test Lab registration belong to the separately coordinated
integration, outside this exact foundation scope.

## Remaining before a physical Home handler may become ready

1. Authenticated fresh-connect/reconnect/token submission binds issuer **and** sub
   throughout initiation/completion. Explicitly distinguish qualified from legacy
   status; never coalesce an ambiguous legacy refresh token into a new grant.
2. Strict server broker selects only qualified personal rows, honors status/revision
   and permissions, persists refresh by exact row/version and rechecks after awaits.
   No legacy, household, environment, directory-collision or LOCAL-only shortcut.
3. Home consumes that broker and retains fire authorization, deadline/abort,
   connection-replacement/refusal guards and no-retry behavior. Only then may
   independently reviewed server-owned readiness change for the supported scope.
4. Run the real enforcing-role migration/upgrade regressions and fresh-grant/broker
   protocol tests in coordinated slots. Provider acceptance is separately labelled.
   Shared/household grants require additional issuer-qualified use authority.

This foundation supplies no connection selector, authenticated endpoint, physical
operation, provider call or new application permission. No full Home/L8 completion.
