# Real-boundary regression audit

This audit applies the integration-boundary corollary in `CLAUDE.md`: a test double may isolate
logic outside the defect, but closure evidence must execute the database, resolver, image, file, or
protocol seam that actually failed. “Real” here does not always mean a paid external account; a
real local HTTP server or Node resolver is sufficient for protocol/wiring claims. A production
provider claim still needs a separate live acceptance run.

## Dispositions

| Boundary audited | Mock/stub disposition | Required real companion | Status |
|---|---|---|---|
| Ticket-store writes under RLS | Unit router/gateway doubles stay for transition and error-branch coverage; they cannot prove PostgreSQL accepts or owns a row. | `tests/alert-intake-rls-live.spec.ts` and `tests/connector-webhook-rls-live.spec.ts` drive the real routers, `PostgresTicketStore`, GUC wrapper, NOBYPASSRLS role, policies, and rows. Both are mandatory in `tests/e2e-green-suite.txt`. | Real companion present. |
| Installed-package `@/` resolution | Route fixtures without framework imports stay for mount ordering/auth behavior; they no longer stand as alias evidence. | `tests/unit/manifest-route-mounter.spec.ts` registers the production `tsconfig-paths` hook and uses Node `createRequire` from an external temporary package to load a real module through `@/`. | Real companion present. |
| Package-facing build artifacts | Source/barrel checks remain useful but cannot prove the shipped image contains a module. | `scripts/check-kernel-skills.ts --image` inspects the built container; `tests/unit/kernel-uses-declaration.spec.ts` removes exact artifacts from a complete build fixture and requires the real gate to fail. | Real companion present. |
| Provider and connector gateways | Mocked fetch/provider specs are retained only for deterministic request shaping, status mapping, and retry branches. They may not close a “live provider works” outcome. | Local protocol-server tests close transport/wiring defects. Items explicitly requiring production OAuth, billing, hardware, or deployed-provider behavior remain in `docs/BACKLOG.md` until dated live evidence exists. | Explicitly separated; live outcomes remain queued. |
| Durable swarm-memory provenance ledger | Pool-less service/route doubles cover normalization and HTTP decisions but cannot prove migration 117 permits the intended owner flow or blocks a second owner. | A real/wrapped-Pool test must exercise two owners plus operator promotion against migration 117 after its RLS policy is corrected. | Open SEC-05 blocker; this audit item cannot close before that test lands. |

## Rules for future fixes

1. Name the failed boundary in the test header and name what remains doubled.
2. Self-validate the fixture where bypass is possible: prove RLS is enforcing, the resolver loaded
   from outside the repo module, or the artifact probe turns red when the file is removed.
3. Put non-optional live/database guards in a required suite. Missing environment is a failure, not
   a skip, unless the outcome is explicitly retained as externally blocked in the active backlog.
4. When a scoped mock remains, link its real companion here. When the companion closes, move the
   completion narrative to durable evidence and remove the item from the active queue.
