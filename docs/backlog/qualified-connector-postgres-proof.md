# Qualified personal connectors: real PostgreSQL proof

## Result and scope

On 2026-09-30, one isolated Linux execution passed all **35 cases**, without
skips or retries, in the three enforcing-role PostgreSQL companions. This is
database-boundary evidence for migration 181 and the qualified credential,
grant and broker implementations. It is not a deployment, real provider consent,
installed Utilities acceptance or physical Home action receipt.

| Companion | Cases passed | Elapsed | Frozen product/spec source |
| --- | ---: | ---: | --- |
| `connector-qualified-credentials-postgres.spec.ts` | 8 | 10.554 s | `f784c69b7f176b4ca1ed8b1445c14845e8d31e91` |
| `connector-qualified-grants-postgres.spec.ts` | 18 | 8.871 s | `ec4cbce39d2f8e4099f750c0eee0b70040411b09` |
| `connector-qualified-broker-postgres.spec.ts` | 9 | 11.557 s | `135771c76c775f7271b17969c78f218f7115d030` |

The measured boundary includes actual migrations, constraints, transactions,
row locks, concurrency, legacy-row preservation, issuer/sub isolation and
table-owner FORCE RLS under NOSUPERUSER/NOBYPASSRLS roles. The broker companion
uses the real `pg` timestamp decoder, request identity/GUC/session wrappers,
crypto and persisted microsecond compare-and-set. Its refresh-provider response
is a named double; no live account was contacted.

## Exact source and test transport

These are pinned product/spec snapshots with an explicitly reviewed **test-only
transport overlay**, not an unmodified older pull-request head. The relevant
product/spec and transitive production blobs match composed core
`a2522baa1600a6b372648a46f9bb5931a3dd4377`. That commit includes the same transport
blobs used by the run:

- `tests/helpers/disposable-postgres.ts`: `9b7fe56d38c6981571ce58f9a9ad9375b3b62f6f`.
- `tests/helpers/owned-postgres-transport.ts`: `8eb48217f57a00d09717c86c6c4b09339c332eec`.
- The separate transport guard, not a selected PostgreSQL suite:
  `tests/unit/owned-postgres-transport.spec.ts`,
  `4e0063f022d2a3d6aff7aea244108f9771aa0d25` (57 focused cases passed).

Independent import-closure review checked 43 credential, 17 grant and 22 broker
paths with no unresolved local imports. Two execution-metadata differences remain
explicit: the composed package adds an unrelated anonymous-route test script,
and its Vitest configuration adds the separately reviewed serial Tree-walk
project. These three suites remain in ordinary unit discovery. This is scoped
source-equivalent evidence, not execution of the entire composed archive/config.

The host supplies its newly created server through a fixed read-only contract.
The fixture still creates real roles and applies the actual migrations. It
rejects inherited deployment DSNs, expired or foreign contracts, wrong server
markers, populated databases and repeat claims. The ordinary Docker-owned
fixture remains the default; invalid opt-in does not fall back to another server.

## Runtime and retained evidence

The run used one 1024 MiB test container and one 512 MiB PostgreSQL container
at a time, one CPU each, a 384 MiB worker heap and zero retries. Admission required
3584 MiB available; the monitored reserve was 2048 MiB. Each suite had a 600-second
deadline, with a 3300-second whole-run limit and bounded owned-resource cleanup.
Actual execution lasted 52 seconds (00:07:17–00:08:09 UTC); admission saw 6025 MiB
available. No memory/deadline stop occurred.

The network was private/internal, with no published ports, deployment credentials,
host Docker socket inside the runner or existing database reuse. After completion,
the exact invocation's container/network labels matched no remaining resources;
the nine pre-existing application/data containers were unchanged and healthy.

- Dependency image: `sha256:9e9d0fb26b579f9db9acf723ad7d4208814f465e40b1145a1e819b4a5e2e5c9e`.
- PostgreSQL image: `sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb`.
- Source manifest SHA256: `561551bf729af573ff1afc4d4ce4dc0b10fc335b669eaf450a5c55ed0c75e70d`.
- Bound plan SHA256: `807ad96464bcdf962c81a9e4944610ce569db1df1042f0bed2bd64328e1183e0`.
- Dependency proof SHA256: `b0830434d56c237f2dbc17c715d22992be95a87691edd4574e3fcc4a8ec6ee71`.
- Credentials result SHA256: `9f9ef51283f4d162fd46a4f660566d39877abd768c18779963393282b28534a5`.
- Grants result SHA256: `fe946b852badc7a959efc36c14d11fc957abee21aab1f11e8edc73250b6fbfd3`.
- Broker result SHA256: `d903dd22c698421cd5fa763db7d41eb9943dddcce0ef11f24d5b06fec65136f9`.

Raw runner logs, Vitest JSON assertions, result receipts, source manifests and
cleanup readbacks are retained in local coordination evidence. Hashes identify
those actual files; this summary is not a replacement for their contents.

For a new Docker-owned run from the committed source, select these same three
specs using the existing fixture; allocate its runtime first:

```sh
NODE_OPTIONS=--max-old-space-size=384 node --max-old-space-size=128 node_modules/vitest/vitest.mjs run --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384 tests/unit/connector-qualified-credentials-postgres.spec.ts tests/unit/connector-qualified-grants-postgres.spec.ts tests/unit/connector-qualified-broker-postgres.spec.ts
```

The host-owned transport additionally requires the separate reviewed host runner
and its fresh ownership contract. Do not manufacture a contract from an existing
database or substitute a production DSN. A rerun needs its own execution receipt.

## Still open

Retain installed owner-bound consent/reconnect/revoke, intended-image and real
provider acceptance. Integrate and prove the separate Home handler's final action
authorization, qualified connection and supported device operation before any
physical-readiness change. Legacy adoption, shared/household grants, key rotation
and erasure are separate work. This database result alone closes none of those
broader backlog outcomes.
