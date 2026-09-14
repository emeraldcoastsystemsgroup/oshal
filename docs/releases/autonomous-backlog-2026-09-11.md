# Autonomous backlog run: 2026-09-11

## Version checkpoint

Before this run, core HEAD and remote branch `feat/store-compatibility-gate` both identify
`3f04ce734a4f631a3c821648261462a5eca84b30`; the tracked working tree is clean. This includes the
authorization foundation and previous platform-readiness work. PR431 remains open with required
independent review. This is a source checkpoint, not a deployed release declaration.

Prior authorization verification recorded 178 passing tests in 15 registered suites. The
registration parity test was rerun before this request and passed. Public application source
is at `d75fe4757f17e7777b6038b036262fa421301fe6`. No new deployment is claimed.

## Scope and evidence

The [ranked plan](../backlog/next-priorities.md) defines ten autonomous implementation outcomes.
The [government-contracting process backlog](../backlog/government-contracting-crm.md) is an
additional planning deliverable. Record completed work, commands, results and commit identifiers
here as each lane is verified. Pending outcomes remain pending until proved.

## Source checkpoints

- Core planning checkpoint: `fc49d42d`; initial implementation checkpoint: `15dcbbd7`, pushed to
  PR431's branch. The pre-push check typechecked the committed tree successfully.
- Final implementation checkpoint: `f12da8b70af312135bf03ab773b39aa67970a3bd`, including the
  briefing pool/lifecycle regression fixes and all new core suite registrations.
- Public pilots: `dc4c0dc` on `feat/package-test-catalog-pilots`; Hello 1.2.0 and Portrait 1.12.0.
  Install only after core provides the `test-catalog` capability.
- Public briefing adoption: `571838a`; Kalshi 1.5.0 declares `jarvis-briefings` and `test-catalog`.
  These package changes are collected in public store PR185, dependent on core PR431.
- Private process/test inventory documentation: PR180 merged at `4248e2e`. Government contracting
  CRM and contract-management work is recorded in its owning private backlog; runtime construction
  is not claimed by this planning deliverable.
- The private specialist consumer and its new catalog are versioned in that repository's PR181,
  with implementation `f5e6c92` and inventory evidence `77d4b7a`. Its business details stay private.

## Verified first implementation checkpoint

Counts below are per targeted run and overlap; they are not summed into a distinct-test total.

| Outcome | Evidence | Result |
|---|---|---|
| 1. Existing principal inventory | `principal-directory.spec.ts`, plus identity/provider regressions | 8 new cases; 44 in the combined run |
| 2. Account setup and Users | `local-account-administration.spec.ts`, `users-administration-browser.spec.ts`, local auth/installer/recovery regressions | 17 new PostgreSQL/browser cases; 20 existing auth/bootstrap and 7 recovery cases |
| 3. Package test catalogs | Three `package-test-catalog*.spec.ts` suites, plus existing platform/kernel tests | 19 new cases; 71 related regressions |
| 4. Package pilots | Native package runners and real core installer/Lab HTTP fixture | Hello 2; Portrait 324 checks/groups; camera 23; shared picker 4; both installed smokes pass |
| 5. Isolated nightly regression | `node scripts/ci/run-nightly-isolated.mjs --scheduled` | 59 cases in 8 suites, zero skips |
| 6. Bot runtime initialization | Two new manifest-bot authority/default suites; related manifest dispatch/selector/lifecycle runs | 19 new cases; related 39-case and 64-case runs |
| 8. Re-enterable first run | `npm run test:provisioning -- --reporter=dot` | 13 cases in 3 suites, including two review-discovered regressions |

Authorization and platform registration parity passed again (14 cases in two suites). The new
scenario metadata points to runnable local commands and labels unavailable host runners honestly.
The test Lab browser is not a shell launcher and does not claim these local runs as live passes.

References: [principal directory](../security/principal-directory.md),
[Users administration](../security/local-account-administration.md),
[catalog contract](../testing/package-test-catalog.md),
[isolated nightly](../testing/isolated-nightly.md),
[bot initialization](../testing/manifest-bot-initialization.md),
[first-run provisioning](../testing/first-run-provisioning.md).

## Combined local validation

These commands use the same suite paths as AI Test Lab. Counts overlap the implementation evidence
above and are not a distinct-test total. JSON results and process logs are retained locally under
`temp/autonomous-*-results.json` and `temp/autonomous-*-output.log`.

An inventory of added core suite files since `3f04ce73` finds **21 new suite files and zero missing
Lab references**. Registration parity checks also compare exact suite sets with the local commands.

| Command | Passing cases | Suite files |
|---|---:|---:|
| `npm run test:authorization` | 227 | 21 |
| `npm run test:platform-readiness` | 144 | 13 |
| `npm run test:bot-initialization` | 56 | 6 |
| `npm run test:provisioning` | 13 | 3 |
| `npm run test:specialist-context` | 31 | 2 |
| `npm run test:briefings` | 30 | 3 |
| Registration parity: autonomous, platform and authorization route suites | 16 | 3 |

The audit-history addition contributes nine new PostgreSQL/HTTP/tool/browser cases within the
authorization command. Specialist dispatch contributes 31 cases covering known answers, exact
identity, separate bot/read grants, revocation, ownership, lifecycle, deadline and transport refusal.
Its actual private package consumer also passes six new behavior cases and four existing suites;
an isolated core installer/Lab HTTP fixture verifies registration and scoped data without live records.

Briefing preferences add 30 PostgreSQL/HTTP/identity/browser cases. The earlier focused run including
existing catch-up and kernel checks passed 91 cases in five files, before five additional pool and
lifecycle regressions were added. Coverage includes exact recipients,
current access, durable preferences, concurrent claims, source/account revocation, reserved producer
sessions, microsecond-safe visible task pagination and mixed ordinary/briefing announcements.
Two-connection concurrent claims preserve a single winner and actual database identity. A
single exhausted connection causes bounded refusal and rollback; late identity reads cannot
resume a delivery write. Overlapping activation and retirement cannot restore a stale source.
The final package installation/catalog lifecycle rerun passes 20 cases in two files.

Kalshi's new compiled scan-path regression passes with 46 Node cases across three suites and five
existing Chromium cases in its fourth suite. The five-case package catalog registers those four
suites plus the existing smoke. Declined briefing enqueue does not finish a task or mark delivery;
the existing first-seen scan ledger is preserved and enabling later does not replay skipped hands.

Both TypeScript configurations pass, as do scoped ESLint across 98 changed JavaScript/TypeScript
paths, the active-backlog guard, repository separation check and links in all 13 final changed
Markdown files. New code follows the repository's change-log and
bounded-function conventions. GitHub Actions were not added or invoked.

References: [specialist facts](../apps/specialist-context.md),
[briefing preferences](../apps/jarvis-briefings.md), [audit history](../security/authorization-audit.md).

## Committed-source compatibility

The final gate passed against core `f12da8b70af312135bf03ab773b39aa67970a3bd` and public store
`571838aff8a2d874c1edc77b661aba78fb4d6291`: **388 sources across 52 packages**, zero stale modules.
The same run proved that an invented ambient framework export is rejected by the real compiler
with TS2305. Both inputs were exported from Git; ignored files and working-tree edits were excluded.

```text
node scripts/check-store-compatibility.mjs --core C:/Projects/oshal --core-ref f12da8b7 --store C:/Projects/oshal-applications --store-ref 571838a --dependencies C:/Projects/oshal --reports <OS-temp>/oshal-autonomous-compatibility-20260911 --prove-rejection
```

The retained report is `oshal-autonomous-compatibility-20260911/run-J5pk91/result.json` beneath OS
temporary storage, beside compiler and rejection logs. The publication gate and pre-push exported
HEAD typecheck also passed. Implementation commits are pushed; the final evidence update changes
documentation only.

## Remaining rollout evidence

All ten selected implementation outcomes have local source proof. Required independent core PR review, installed deployment
proof, real provider/model runs and a complete unattended green nightly are not established by
the isolated suites. The previous full-nightly failures remain recorded in the isolated-nightly note.
Core [PR431](https://github.com/emeraldcoastsystemsgroup/oshal/pull/431) still requires independent
review before deployment. Public [PR185](https://github.com/emeraldcoastsystemsgroup/oshal-applications/pull/185)
and the private consumer PR depend on the core capabilities. No live Lab run, account migration,
application-data action or deployment is claimed by these local results.
