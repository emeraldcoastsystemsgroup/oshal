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
- Public pilots: `dc4c0dc` on `feat/package-test-catalog-pilots`; Hello 1.2.0 and Portrait 1.12.0.
  Install only after core provides the `test-catalog` capability.
- Private process/test inventory documentation: PR180 merged at `4248e2e`. Government contracting
  CRM and contract-management work is recorded in its owning private backlog; runtime construction
  is not claimed by this planning deliverable.

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

## Remaining evidence at this checkpoint

Ranks 7, 9 and 10 are in progress. Required independent core PR review, installed deployment
proof, real provider/model runs and a complete unattended green nightly are not established by
the isolated suites. The previous full-nightly failures remain recorded in the isolated-nightly note.
