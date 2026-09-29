# Fresh issuer-qualified personal grants

Status: **Service source integrated with HTTP/console; not deployed acceptance.** This
slice adds a storage lifecycle over the [qualified foundation](qualified-connector-credentials.md).
It does not change existing connections, schema, crypto, broker, permissions or
provider behavior. The composed candidate's authenticated SmartThings bridge and Utilities
controls are documented in the [connector architecture](../architecture/connectors-and-graph-architecture.md#36-fresh-issuer-qualified-personal-grants).
Home/L8 physical readiness remains false.

## Service contract

[connector-qualified-grants.ts](../../src/app/routes/connector-qualified-grants.ts)
exports five functions. Each takes `db: QualifiedConnectorQueryable` and
`principal: QualifiedConnectorPrincipal` from the real qualified crypto module.

| Function | Third argument | Result |
| --- | --- | --- |
| `createFreshQualifiedGrant` | `{validatedIdentity:{provider,accountKey},accessToken,refreshToken?,expiresAt}` | New grant metadata; same-account collision refuses |
| `reconnectFreshQualifiedGrant` | Same fresh input plus `{connectionId,expectedRevision}` | Exact existing account replacement by CAS |
| `listQualifiedGrants` | Optional `{limit?,afterConnectionId?}` | Metadata array, default 50 / maximum 100, UUID keyset order |
| `getQualifiedGrant` | `{connectionId}` | Exact owner-qualified UUID metadata; foreign/missing refuses identically |
| `revokeQualifiedGrant` | `{connectionId,provider,accountKey,expectedRevision}` | Exact grant marked revoked by CAS |

Metadata is an explicit allowlist: `connectionId`, `provider`, `accountKey`,
`status`, `revision`, `expiresAt`, `createdAt`, `updatedAt`. No owner tuple,
plaintext, token envelope or wrapped key is returned. Listing does not select
credential columns. `revision` and `expectedRevision` are canonical positive
decimal strings in PostgreSQL BIGINT range, never JavaScript numbers. The
database trigger alone assigns revisions. Timestamps returned are ISO UTC strings.

Use `getQualifiedGrant` for reconnect initiation and DELETE target lookup. It
performs one exact issuer/sub/UUID query without selecting credential columns or
searching a bounded list page. The caller compares its returned provider with the
expected ceremony provider, then stores immutable account/revision server-side.
Do not guess account/provider from browser input. A lookup is a snapshot, not a
write grant: reconnect/revoke still require their existing exact-target revision CAS.

Fresh `expiresAt` is required: either `null` (provider did not supply an expiry)
or a future canonical 24-character UTC ISO string, e.g. `2099-01-01T00:00:00.000Z`.
It is rechecked after encryption before persistence. Stored expired timestamps and
`needs_reconnect`/`revoked` statuses remain visible in metadata; listing is not an
execution/readiness verdict. Fresh writes always set `connected` (create uses the
schema default). Reconnect may deliberately revive a revoked grant only with the
current revision and a newly validated account/credential ceremony. Revoking clears
refresh material but retains the encrypted access column required by the schema;
the separate broker must enforce status/revision on every use. This is not token
erasure or remote provider revocation.

## Trust and transaction boundaries

- The caller authenticates the exact issuer **and** subject and binds one runtime
  transaction client to both before calling. A pool that can switch clients is not
  a valid write port. These APIs issue no BEGIN/COMMIT/ROLLBACK, session settings,
  operator flag, system identity or permission grant. FORCE RLS is independent
  defense; there is no fallback when the query port is misbound.
- `validatedIdentity` is mandatory output from a trusted **server-side provider
  verifier**, concerning the same newly supplied credentials. It is not proof by
  itself and must never come directly from an unverified HTTP account/email field.
  This slice does not implement that verifier, endpoint authentication, consent,
  OAuth state or replay controls. An old subject-only row, email, LOCAL issuer or
  lack of a directory collision cannot establish identity for this API.
- Principal, account, target, tokens and expiry are copied/validated before the
  first await. Text preserves exact spelling, rejects blank/padded/control-bearing
  identities and invalid UTF-8, and has the foundation's byte bounds. Tokens have
  the real crypto's 1–65536-byte UTF-8 bound. SQL identity/account values are bound
  parameters, including the full issuer/sub on every connection query.
- Creation first refuses an already visible account, then encrypts fresh tokens
  and inserts with account-tuple `ON CONFLICT DO NOTHING`. A racing conflict never
  overwrites an account or adopts a legacy row. Reconnection locks the exact
  issuer/sub/UUID/provider/account/revision before touching crypto, then checks
  that entire tuple again in its update. Omitted or null refresh **clears** it;
  supplied refresh replaces it. Nothing reads/coalesces old credential material.
- The caller owns atomic completion and **must roll back the whole transaction
  on every rejection**, including conflict/validation/crypto errors. Encryption
  may have inserted a first-use DEK before a later failure; the module must not
  commit it itself. Hold no provider/network request inside this transaction.
- Fixed outward error `.code` values are `invalid_input`, `conflict`,
  `not_found_or_stale` (same refusal for foreign/missing/stale targets) and
  `storage_failure`. Messages/logs contain only fixed operation/code/duration and
  newly created safe Error stacks, never raw database/crypto causes or credentials.

## Focused guards and honest evidence

[Unit suite](../../tests/unit/connector-qualified-grants.spec.ts) calls the actual
lifecycle and AES-GCM/HKDF implementation. Its named SQL-map double asserts SQL
scope/CAS/parameter shape and simulates returned rows/revisions; logger is doubled.
It does **not** prove PostgreSQL parsing, transactions, locking, constraints or RLS.
Coverage includes success, account collision/race, issuer/subject separation,
exact target refusals, missing-refresh clearing, revocation, mutable inputs,
metadata-only pagination, expiry race, bounded validation and sanitized failures.
The exact UUID lookup guards additionally cover targets outside the first page,
foreign/missing refusal, revoked/expired metadata, snapshotting and safe errors.

Authorized focused command (one 384 MiB worker, 128 MiB runner):

```sh
node --max-old-space-size=128 node_modules/vitest/vitest.mjs run --config vitest.config.ts --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384 --testTimeout=15000 --hookTimeout=15000 tests/unit/connector-qualified-grants.spec.ts
```

Each run requires fresh host RAM >=1800 MiB, a monitored >=600 MiB reserve and
180-second whole-process deadline. Source mutation controls are run sequentially,
must fail their named assertions, and are restored exactly before final green.
Exact hashes and run receipts are retained in shared local coordination.

Local source receipt (2026-09-29): 56 focused cases passed before and after mutation controls.
Replacing omitted refresh with access material failed both null-clearing cases;
substituting revision `1` failed the stale-revision guard and two lifecycle cases;
deriving issuer from subject failed 13 identity/crypto/refusal cases, including a
wrong-issuer operation succeeding unexpectedly. All three source mutations were
restored byte-for-byte. These are source/double outcomes, not RLS evidence.

Exact-UUID follow-up: the focused suite grew to 63 passing cases. An actual-source
mutation spreading the doubled raw row into the lookup result failed three
metadata-allowlist assertions; restored before final verification. The double
deliberately returns extra credential fields to exercise defensive projection;
the production SELECT itself still requests metadata only. Existing four lifecycle
function bodies are unchanged by this additive lookup.

[PostgreSQL companion](../../tests/unit/connector-qualified-grants-postgres.spec.ts)
is **SOURCE ONLY / UNRUN**. When explicitly scheduled, its actual
`DisposablePostgres` owns a 256 MiB temporary server, minted fixture credentials,
migrations 060/100/181 and NOSUPERUSER/NOBYPASSRLS runtime-role pools. The runtime
role owns FORCE-RLS tables. It never reads an inherited DSN or deployment secret.
Tests target actual create/list/reconnect/revoke, same-sub issuer isolation,
misbound sessions/operator non-bypass, concurrent account/CAS races, locked
reconnect, rollback of both key and grant, metadata pagination and legacy rows
unchanged. Teardown closes fixture-owned pools and removes its owned server even
after startup failure. No skip switch substitutes for a missing runtime.

The coordinated runtime command is the same bounded runner selecting
`tests/unit/connector-qualified-grants-postgres.spec.ts` instead, with runtime
startup/teardown budget explicitly assigned before execution. No PostgreSQL,
provider, HTTP/browser, installed image or Home/L8 acceptance is claimed here.

## Remaining integration

The composed candidate adds authenticated endpoints/ceremony, fresh SmartThings location
verification, Utilities controls and Test Lab/docs-index/audit references. Remaining:
Home broker consumption/revalidation, real enforcing-role companion execution,
installed owner-bound consent/browser proof, full composed types and normal pre-push gate.
The storage service itself does not register routes or widen existing permissions.
Shared/household grants, legacy adoption, KEK rotation and credential erasure remain
separate governed work. Do not expose a physical-ready flag merely because these
storage functions are present.
