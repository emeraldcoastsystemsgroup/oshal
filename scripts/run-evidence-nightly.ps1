<#
  run-evidence-nightly.ps1 -- Task Scheduler wrapper for the nightly competitive-evidence refresh.

  WHY: the competitive scoreboard caps every category at 75 once its `Proof-Tier: live`
  evidence ages past the freshness window. `npm run evidence:nightly` re-runs the headless
  prove-*-live.ts generators + regenerates the score artifacts so the board self-heals
  instead of decaying between sessions. This wrapper exists so the scheduled task gets:
    - COMPETITIVE_EVIDENCE_MAX_LIVE_AGE_HOURS=26 (a hair over the daily cadence, per the
      market-remediation runbook, so one missed night does not flip the whole board red)
    - a dated log under logs/evidence-nightly/ (gitignored) so a silent 3:30am miss is
      diagnosable the next morning
    - a health preflight note: generators hit the live stack at 127.0.0.1:35457 (NOT
      `localhost` -- the wslrelay ::1 squatter gotcha). A down stack is LOGGED but does not
      abort: nightly-refresh tolerates flaky proofs and still writes an honest score.

  NOTE: keep this file pure ASCII. PowerShell 5.1 reads BOM-less .ps1 as ANSI, and UTF-8
  em-dash bytes decode to a CP-1252 curly quote that terminates strings early (parse error).

  Scheduled by scripts/register-evidence-nightly.ps1 (task 'OSHAL-Evidence-Nightly').
  Run manually:  powershell -ExecutionPolicy Bypass -File scripts/run-evidence-nightly.ps1
#>
# NOT 'Stop': native commands write progress to stderr, which PowerShell 5.1 under Stop
# turns into terminating NativeCommandError. Real failure is gated on npm's exit code.
$ErrorActionPreference = 'Continue'

$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repo 'logs\evidence-nightly'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$log = Join-Path $logDir ((Get-Date -Format 'yyyy-MM-dd') + '.log')

function Note($m) { ("[{0}] {1}" -f (Get-Date -Format s), $m) | Out-File $log -Append -Encoding utf8 }

Set-Location $repo
$env:COMPETITIVE_EVIDENCE_MAX_LIVE_AGE_HOURS = '26'
Note "=== nightly evidence refresh starting (repo $repo) ==="

# Preflight: is the live stack up? Note it either way -- the run proceeds regardless, because
# refresh-local reports individual generator failures without aborting, and the score
# regeneration honestly reflects any proof that could not be refreshed.
try {
  $h = Invoke-WebRequest 'http://127.0.0.1:35457/api/health' -TimeoutSec 10 -UseBasicParsing
  Note "preflight: api health $($h.StatusCode) - live stack UP"
} catch {
  Note "preflight: api at 127.0.0.1:35457 unreachable - live stack DOWN; stack-dependent proofs will fail honestly (recover with scripts/oshal-up.sh)"
}

# cmd /c so native stdout+stderr land in the log without PS 5.1 ErrorRecord wrapping.
cmd /c "npm run evidence:nightly >> `"$log`" 2>&1"
$exit = $LASTEXITCODE
Note "=== nightly evidence refresh finished (exit $exit) ==="

# Keep the last 14 nightly logs.
Get-ChildItem $logDir -Filter '*.log' | Sort-Object Name -Descending | Select-Object -Skip 14 |
  ForEach-Object { try { Remove-Item $_.FullName -Force -Confirm:$false } catch {} }

exit $exit
