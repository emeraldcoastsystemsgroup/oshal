# Scheduled tasks: which checkout each one runs (ADR-115)

[ADR-115](../adr/115-clean-trunk-branch-strategy.md) made this repository the development trunk and
`emeraldcoastsystemsgroup/open-shal` — checked out on the dev box at
`C:\Projects\open-shal-swarm-harness-agent-llm` — a **frozen reference archive**. Its working tree
has not moved since the cutover commit (`55e99bca`, 2026-07-23).

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

## Inventory (dev box, read 2026-09-16)

Enumerate with `Get-ScheduledTask | ForEach-Object { $_.TaskName; $_.Actions }` (read-only).

### Already on the trunk

| task | action |
|---|---|
| OSHAL Daily Trade Recap | `wscript //B //Nologo C:\Projects\oshal\scripts\run-daily-recap-hidden.vbs` |
| OSHAL Kalshi Forward Test | `C:\Projects\oshal\scripts\kalshi-forward-daily.cmd` |
| OSHAL Lab Report Publish | `wscript //B //Nologo C:\Projects\oshal\scripts\publish-lab-report-hidden.vbs` |
| OSHAL Local CI | `wscript //B //Nologo C:\Projects\oshal\scripts\ci-local-hidden.vbs` |
| OSHAL Stack Watchdog | `wscript //B //Nologo C:\Projects\oshal\scripts\oshal-stack-watchdog-hidden.vbs` |
| OSHAL Trading Watchdog | `wscript //B //Nologo C:\Projects\oshal\scripts\trading-watchdog-hidden.vbs` |
| OSHAL Weekly Report | `wscript //B //Nologo C:\Projects\oshal\scripts\publish-oshal-report-weekly-hidden.vbs` |
| OSHAL-Store-Publish | `wscript //B //Nologo C:\Projects\oshal\scripts\publish-store-nightly-hidden.vbs` |

### Still naming the archive

| task | state | action | disposition |
|---|---|---|---|
| OSHAL Claude token keepalive | Ready | `wscript //B //Nologo C:\Projects\open-shal-swarm-harness-agent-llm\scripts\claude-token-keepalive-hidden.vbs` | repoint — run the registrar |
| OSHAL Signal Labeler | Ready | `wscript //B //Nologo C:\Projects\open-shal-swarm-harness-agent-llm\scripts\oshal-signal-daily-hidden.vbs` | repoint — run the registrar |
| OSHAL-Evidence-Nightly | Ready | `wscript //B //Nologo C:\Projects\open-shal-swarm-harness-agent-llm\scripts\run-evidence-nightly-hidden.vbs` | **stays** — see above |
| JobHunterSwarmSync | **Disabled** | `C:\Projects\open-shal-swarm-harness-agent-llm\apps\career-hunter\sync\run_swarm_sync.cmd` | not movable — `apps/` is runtime staging, never tracked (Rule 0c); the target does not exist in this repo. Unregister it or leave it disabled. |

## Repoint (operator action — run from `C:\Projects\oshal`)

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
