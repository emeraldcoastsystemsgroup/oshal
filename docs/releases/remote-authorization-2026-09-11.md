# Protected remote authorization — 2026-09-11

This increment follows core checkpoint `8120ce6750ce0de38c3e4cbe5af585970ed23a02` on the existing
`feat/store-compatibility-gate` branch and PR 431. It implements the next protected remote
execution boundary described in the [protocol reference](../security/remote-application-execution.md).

The source changes add durable signed execution provenance, current-rights controller permits,
restricted hosted worker reasoning, immutable queued initiators, exact-principal result delivery,
installation migrations 132–133 and AI Test Lab registration. New tests use isolated policy/HTTP,
SQLite and disposable PostgreSQL fixtures. No GitHub Actions are requested or added.

## Verification

| Local check | Result |
|---|---|
| `npm run test:remote-authorization` | 263 tests across 23 suites passed; zero failures or skips. |
| `npm run test:authorization` | 228 tests across 21 suites passed; zero failures or skips. The commands overlap and their counts are not additive. |
| `npm run typecheck` | Both application and server TypeScript configurations passed. |
| Scoped ESLint | All 66 changed, linted code paths passed; the legacy `any-bot` file is ignored by ESLint and passed `node --check` separately. |
| Repository separation, active-backlog and changed-document link checks | Passed. |
| AI Test Lab registration parity | Passed within the remote runner; all ten new suite files are included in its fixed 23-suite command. |

The implementation supports direct hosted reasoning without tools. Protected agentic, CLI,
provider-intent and raw mesh/batch execution remain refused. The registered Lab scenario is
`protected-remote-application-execution`; its browser step reports the local-runner prerequisite
instead of inventing a deployment result.

Local JSON reports are retained in `temp/remote-authorization-final-results.json` and
`temp/remote-authorization-foundation-results.json`. These isolated fixture results are source
evidence; required PR review and a deployed application canary remain separate release steps.

## Publication checkpoint

Implementation commit `c875a5085f4084178301446d448fa841d58ce8d5` is pushed on
`feat/store-compatibility-gate`. The publication gate and pre-push typecheck of an exported committed
HEAD both passed. [PR 431](https://github.com/emeraldcoastsystemsgroup/oshal/pull/431) remains open
with required independent review; this record does not claim a merge or deployed canary.

Pinned compatibility passed for that core commit and unchanged public store commit
`571838aff8a2d874c1edc77b661aba78fb4d6291`: 388 sources across 52 packages. The real compiler also
rejected the deliberately invented ambient export with TS2305. The command was:

```text
node scripts/check-store-compatibility.mjs --core C:/Projects/oshal --core-ref c875a5085f4084178301446d448fa841d58ce8d5 --store C:/Projects/oshal-applications --store-ref 571838aff8a2d874c1edc77b661aba78fb4d6291 --dependencies C:/Projects/oshal --reports <OS-temp>/oshal-remote-compatibility-20260911 --prove-rejection
```

The retained report is `oshal-remote-compatibility-20260911/run-nAFyTb/result.json` under the OS
temporary directory. Store repositories were not changed by this increment. Public store PR 185
and private consumer PR 181 continue to depend on core promotion.
