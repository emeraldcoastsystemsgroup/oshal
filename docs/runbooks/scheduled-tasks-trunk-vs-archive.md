# Scheduled tasks: which checkout each one runs (ADR-115)

[ADR-115](../adr/115-clean-trunk-branch-strategy.md) made this repository the development trunk and
`emeraldcoastsystemsgroup/open-shal` — checked out on the dev box at
`C:\Projects\open-shal-swarm-harness-agent-llm` — a **frozen reference archive**. Its git HEAD has not
moved since the cutover commit (`55e99bca`, 2026-07-23). **Its working tree is NOT frozen:** `git
status` there reports about 2,600 entries, including uncommitted post-cutover hand-edits to
`scripts/run-daily-recap.ps1` (2026-07-28) and `scripts/assemble-recap.js` (2026-07-29). Check
`git -C C:\Projects\open-shal-swarm-harness-agent-llm status --short` before moving anything out of
it — the recap, below, is exactly that case.

A Windows scheduled task that still names that path therefore runs code from July. It is not a
stale-looking run; it is a different program. Measured on 2026-09-16, the archive's copies differ
from this trunk's by:

| file | changed lines, archive vs trunk |
|---|---|
| `scripts/run-daily-recap.ps1` | 838 |
| `scripts/oshal-signal-label.js` | 234 |
| `scripts/assemble-recap.js` | 15 |
| `scripts/claude-token-keepalive.ps1` | 4 |
| `scripts/oshal-signal-mine.js` | 4 |

Reproduce with `diff C:/Projects/open-shal-swarm-harness-agent-llm/<file> C:/Projects/oshal/<file>`.

## The rule

**A scheduled-task launcher resolves its payload from its own directory, never from a typed path.**

- `.vbs` wrappers: `fso.GetParentFolderName(WScript.ScriptFullName)`, then run the sibling.
- `.cmd` launchers: `cd /d %~dp0..`.
- `register-*.ps1`: build the action from `$PSScriptRoot`, and pass `-WorkingDirectory $repo`.

Then the task follows whichever checkout it was registered from, and repointing it is one command
instead of a hand-edit in the Task Scheduler GUI.

`tests/unit/scheduled-task-launchers-self-locating.spec.ts` enforces this over every `scripts/*.vbs`,
`scripts/*.cmd` and `scripts/register-*.ps1`. It gates on the **shape** of a typed checkout
(`C:\Projects\<anything>`), not on the archive's name, because the hazard is "pinned to a tree that
is not the one it ships in" — equally broken when the typed path happens to be the trunk.

## The one deliberate exception

`OSHAL-Evidence-Nightly` **stays on the private archive on purpose.** Its wrapper drives
`npm run evidence:nightly`, which writes the competitive-evidence board to `docs/evidence/` —
internal-only, refused by the publish gate, and absent from this public trunk by design
(Rule 0b). Repointing it at `C:\Projects\oshal` would have the nightly write a board into a tree
that cannot hold one.

`scripts/run-evidence-nightly-hidden.vbs` declares this in-band with the marker
`OSHAL-INTENTIONAL-ARCHIVE-PATH`, and the guard asserts both directions: no other launcher may
name the archive, and this one may not be silently "fixed" into self-locating.

If the board is ever relocated, the order is: move `docs/evidence/` to its new private home, then
drop the marker, make the launcher self-locating, and re-register from the trunk.

`scripts/register-evidence-nightly.ps1` is self-locating like every registrar
(`$repo = Split-Path -Parent $PSScriptRoot`), so running it from this checkout would repoint the task
here. Do not run it from the trunk while `docs/evidence/` lives only in the archive. The live task
still names the archive and still runs there: last start 2026-09-20 03:30:01, result 0, log
`logs/evidence-nightly/2026-09-20.log` in the archive tree (read 2026-09-21).

## Inventory (dev box, read 2026-09-16, re-read 2026-09-21)

Enumerate with `Get-ScheduledTask | ForEach-Object { $_.TaskName; $_.Actions }` (read-only).

### On the trunk

| task | action |
|---|---|
| OSHAL Claude token keepalive | `wscript //B //Nologo "C:\Projects\oshal\scripts\claude-token-keepalive-hidden.vbs"`, working directory `C:\Projects\oshal` — repointed 2026-09-16 |
| OSHAL Daily Trade Recap | `wscript //B //Nologo C:\Projects\oshal\scripts\run-daily-recap-hidden.vbs` — the launcher only; its asset root is still the archive, see below |
| OSHAL Kalshi Forward Test | `C:\Projects\oshal\scripts\kalshi-forward-daily.cmd` |
| OSHAL Lab Report Publish | `wscript //B //Nologo C:\Projects\oshal\scripts\publish-lab-report-hidden.vbs` |
| OSHAL Local CI | `wscript //B //Nologo C:\Projects\oshal\scripts\ci-local-hidden.vbs` |
| OSHAL Signal Labeler | `wscript //B //Nologo "C:\Projects\oshal\scripts\oshal-signal-daily-hidden.vbs"`, working directory `C:\Projects\oshal` — repointed 2026-09-16 |
| OSHAL Stack Watchdog | `wscript //B //Nologo C:\Projects\oshal\scripts\oshal-stack-watchdog-hidden.vbs` |
| OSHAL Trading Watchdog | `wscript //B //Nologo C:\Projects\oshal\scripts\trading-watchdog-hidden.vbs` |
| OSHAL Weekly Report | `wscript //B //Nologo C:\Projects\oshal\scripts\publish-oshal-report-weekly-hidden.vbs` |
| OSHAL-Store-Publish | `wscript //B //Nologo C:\Projects\oshal\scripts\publish-store-nightly-hidden.vbs` |

### Still naming the archive

| task | state | action | disposition |
|---|---|---|---|
| OSHAL-Evidence-Nightly | Ready | `wscript //B //Nologo C:\Projects\open-shal-swarm-harness-agent-llm\scripts\run-evidence-nightly-hidden.vbs` | **stays** — see above; last start 2026-09-20 03:30:01, result 0 |
| JobHunterSwarmSync | **Disabled** | `C:\Projects\open-shal-swarm-harness-agent-llm\apps\career-hunter\sync\run_swarm_sync.cmd` | not movable — `apps/` is runtime staging, never tracked (Rule 0c); the target does not exist in this repo. Unregister it or leave it disabled. |

### The two repointed tasks, verified 2026-09-21

Both registrars were run on 2026-09-16 (each task's trigger start boundary carries that date) and both
tasks have executed the trunk since — measured, not assumed:

- **Keepalive** — `LastRunTime 2026-09-20 22:23:54`, `LastTaskResult 0`; `%USERPROFILE%\.claude\keepalive.log`
  runs through `2026-09-20 22:24:52 OK: token has 6.39h left - nothing to do`.
- **Signal Labeler** — `C:\Projects\oshal\data\_extracted\signal-daily.log` holds run headers for
  `09/16 16:30:01`, `09/17 16:30:02`, `09/18 19:36:00` and `09/19 17:30:01`; the archive's copy of that
  log ends at `09/15 16:31:34` and has not been written since (file mtime 2026-09-15). The labeler that
  ran is this trunk's, which differs from the archive's `oshal-signal-label.js` by 234 lines
  (re-measured 2026-09-21, unchanged).

  The 09-20 instance reads `LastTaskResult 2147946720` (`0x800710E0`, "the operator or administrator
  has refused the request") at `18:23:10` — the same second the Daily Trade Recap's catch-up fired.
  That code is the scheduler declining to launch under the task's own conditions (the registrar takes
  the `New-ScheduledTaskSettingsSet` defaults: `DisallowStartIfOnBatteries` and
  `StopIfGoingOnBatteries` true, `StartWhenAvailable` false). It is not an exit code from the launcher:
  `oshal-signal-daily.cmd` appends a dated `====` header the moment it starts, and appended none that
  day. Read it as "did not start", never as "ran the wrong tree".

### The recap: launcher on the trunk, asset root on the archive

`OSHAL Daily Trade Recap` runs this trunk's `run-daily-recap-hidden.vbs` → `run-daily-recap.ps1`, but
`$REPO` (`scripts/run-daily-recap.ps1:91`, `OSHAL_RECAP_REPO`-overridable) still defaults to the
archive, and everything the script roots there comes from the archive tree: the vids-operator `out`
directory, `RECAP-BUILD-GOAL.md`, `make-deck-detailed.py` (line 682), `assemble-recap.js` (line 896)
and the `.env` it `Set-Location`s into for `REMOTE_CLIENT_SHARED_SECRET` (line 563). The archive's
`assemble-recap.js` and `run-daily-recap.ps1` are both uncommitted working-tree edits (` M` in
`git -C C:\Projects\open-shal-swarm-harness-agent-llm status --short`, re-read 2026-09-21), so the
`assemble-recap.js` the nightly runs is neither this trunk's copy nor the archive's committed HEAD.
Line 240 also `docker exec`s
`/run/desktop/mnt/host/c/Projects/open-shal-swarm-harness-agent-llm/scripts/alpaca-is-session.js`,
which resolves only because the `oshal-api` service in `docker-compose.oshal-local.yml` (lines
1197–1199 and 1590) bind-mounts this trunk INTO the container at the archive's host path through the
`OSHAL_DOCKER_PROJECT_ROOT` default.

The same root is typed into `scripts/assemble-recap.js:20` (`OSHAL_RECAP_OUT`),
`oshal-recap-email.js:29`, `oshal-recap-render-remote.js:19,22` and `oshal-recap-agent-remote.js:28,31`
(`OSHAL_RENDER_REPO`), `recap-agent-node.ps1:12`, `recap-render-node.ps1:6`,
`publish-agenticfederal-recap.ps1:28`, `publish-ecsg-recap.ps1:28`, `vids-drive.js:18`,
`veo-discover.js:16`, `veo-download-test.js:7`, `veo-grab-src.js:8`, `video-render-smoke.cjs:8` and the
two SOPs under `packages/oshal-vids-operator/`. `.env` sets none of `OSHAL_DOCKER_PROJECT_ROOT`,
`OSHAL_RECAP_REPO`, `OSHAL_RECAP_OUT` or `OSHAL_RENDER_REPO` (keys checked 2026-09-21, values not read).
None of these files is a `.vbs`, `.cmd` or `register-*.ps1`, so the launcher guard does not cover them.

Moving the recap is one coordinated change, not a per-file sweep: relocate the `out` directory
(operator data), change the compose default and recreate the api (a deploy), and flip every default
above in the same commit. A partial move breaks the nightly recap. The BACKLOG entry records it as its
own item; it was not attempted with the launchers.

## Repoint (run on the dev box 2026-09-16 — the recipe for any other box)

These replace the task's action with the trunk's self-locating launcher. Idempotent; schedule,
instance policy and execution-time limit are preserved. Both keep the windowless `wscript` action,
so no console flashes on the desktop.

```powershell
powershell -ExecutionPolicy Bypass -File C:\Projects\oshal\scripts\register-claude-token-keepalive.ps1
powershell -ExecutionPolicy Bypass -File C:\Projects\oshal\scripts\register-signal-labeler.ps1
```

Verify, then test-run:

```powershell
Get-ScheduledTask -TaskName 'OSHAL Claude token keepalive','OSHAL Signal Labeler' |
  ForEach-Object { $_.TaskName; $_.Actions | Select-Object Execute, Arguments, WorkingDirectory }

Start-ScheduledTask -TaskName 'OSHAL Claude token keepalive'
Start-ScheduledTask -TaskName 'OSHAL Signal Labeler'
Get-ScheduledTaskInfo -TaskName 'OSHAL Signal Labeler' | Select-Object LastRunTime, LastTaskResult
```

The signal labeler appends to `C:\Projects\oshal\data\_extracted\signal-daily.log`; the keepalive
appends to `%USERPROFILE%\.claude\keepalive.log`.

Optionally retire the dead job:

```powershell
Unregister-ScheduledTask -TaskName 'JobHunterSwarmSync' -Confirm:$false
```
