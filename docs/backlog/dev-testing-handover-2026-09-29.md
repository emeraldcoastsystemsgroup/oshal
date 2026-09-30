# Testing handover — 2026-09-29

## Current stopping point

The requested scope is the Intelligent Sales CRM on the former GSquared Funding development droplet only. The intended development target is `159.203.88.100`. The production host is `167.172.250.97`; it was not contacted and must remain out of scope.

The CRM code is ready locally, but the dev-droplet deployment and remote acceptance run did not start. The first read-only SSH check failed with:

```text
Permission denied (publickey).
```

No Docker command, migration, provider call, database change, or remote browser acceptance was performed after that failure. The deployment is therefore blocked on restoring the correct SSH key/access for `root@159.203.88.100`, not on an application test failure.

## Code and pull requests

- Core repository: `C:\Projects\oshal`
- Core branch: `codex/config-admin-agent-scope`
- Core commit: `4fba948ab782f2ccecdf08d780e31ad481709d85`
- Core PR #945: https://github.com/emeraldcoastsystemsgroup/oshal/pull/945
- Private applications repository: `C:\Projects\oshal-app-private`
- Private branch: `codex/intelligent-sales-enhanced-core`
- Private commit: `767c62641f9f4e215a59d7edd501583c05698ed6`
- Private PR #192: https://github.com/emeraldcoastsystemsgroup/oshal-app-private/pull/192

PR #945 is open and its hosted `publish-gate` completed successfully, but the PR is still review/branch-protection blocked; it is not merged. PR #192 is open and clean. Do not describe either PR as merged.

The intended dev package is Intelligent Sales `1.20.3` (one bot, 12 tools, parity `269/269`). The local archive prepared for the dev-only deployment is:

- `C:\Projects\oshal\temp\oshal-core-4fba948a.tar.gz`
- SHA-256: `33f016f95127271674e3f6d97b9847c863831bb89310db6cdc9927b63d7ad7a7`
- Intended image tag: `oshal-bot:sha-4fba948ab782f2ccecdf08d780e31ad481709d85`
- Intended release: `/opt/gsquared/releases/4fba948ab782f2ccecdf08d780e31ad481709d85`

## Validation completed locally

- Focused merged-core suite: `162/162` passing across 13 files.
- Source TypeScript typecheck: passed.
- Server TypeScript typecheck: passed.
- The exact pre-push publication gate on `4fba948a`: passed (publish scan and committed-HEAD typechecks).
- Corrected CommonJS runtime/helper files passed `node --check`.
- Changed TypeScript/test paths passed ESLint with zero diagnostics.
- `git diff --check`: clean.
- Core working tree was clean after the push.

The code hardens the protected direct zero-tool path, kills the full Cline process tree on timeout, disables isolated Cline auto-update, disables SDK retries/failover for the protected path, and resolves compatible Gemini usage cost through the existing provider registry while preserving actual provider attribution. No credentials are recorded in this handover.

These are local/code-level results only. They do not prove the dev droplet is reachable or that the CRM has passed live acceptance there.

## Next safe continuation

1. Restore/provide the correct SSH key or access path for `root@159.203.88.100`; do not use the production host.
2. Re-run a read-only identity and container/database baseline check before changing anything.
3. Ship the archive above using the existing dev helper under `/opt/gsquared/ship/core-ecdc59b2/`; preserve the ten-container baseline and recreate only the intended app containers.
4. Verify the image digest, package/version/parity, migrations, RLS, CRM counts, and readiness. A declared-but-unconfigured Google Cloud TTS voice may return readiness `503`; record that as the known TTS caveat, not as a CRM failure.
5. Run the read-only CRM acceptance: the Assistant prompt `Read-only acceptance test: summarize my pipeline counts. Do not create, update, schedule, or contact anything.` followed by the 16 CRM surfaces. Avoid saves, uploads, scheduling, sync-triggering mutations, and contact actions.
6. Append command receipts and results to `COLLABORATE.md` and update the PR notes only after the remote run actually completes.

The broad ADR-164 extended UX/audience-view acceptance remains intentionally backlogged and is still open for live proof. The local browser currently points at `http://localhost:45457/api/intelligent-sales-home`; that is not remote-droplet validation.

## Previously known dev baseline (not re-verified in this attempt)

The older dev handover reported migrations `19`, partners `6962`, opportunities `482`, roles `10672`, relationships `5829`, updates `1373`, reps `12`, calls `6`, audit `210`, view preferences `39`, and email-sync rows `11` (`emailConnected=0`, `emailReconnectRequired=1`, `emailEverSynced=0`), with RLS `27/27` enabled/forced. Treat these as comparison values only until SSH access is restored and a fresh read-only baseline is captured.
