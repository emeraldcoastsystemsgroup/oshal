<#
  deploy-earnings-gate-once.ps1 - ONE-SHOT post-close deploy (2026-07-17): ship the testable
  earnings gate (commit 0d95ac85) and arm it for the PAPER book only.

  Why a scheduled one-shot: deploying mid-session recreates the api and stops the trading loop
  (the 07-15 morning alert storm was exactly market-hours deploy churn), so this waits for the
  close. PAPER-only arming is the platform's soak doctrine: the reference book accumulates
  counterfactual evidence in oshal_trading_gate_blocks; LIVE stays off until that evidence is
  scored and the operator promotes it.

  Registered (run once at 15:05 CT today, then self-deletes):
    schtasks /create /tn "OSHAL Earnings Gate Deploy" /sc once /st 15:05 /f ^
      /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Projects\open-shal-swarm-harness-agent-llm\scripts\deploy-earnings-gate-once.ps1"
  Cancel any time before 15:05 with:
    schtasks /delete /tn "OSHAL Earnings Gate Deploy" /f

  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - one-shot close deploy: build HEAD, arm TRADING_EARNINGS_GATE=paper in .env, recreate api, verify env+symbol, email the outcome, self-delete.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Step 5: seed the egate/ lab A/B twin grid post-verify (self-guarded against a pre-knob api), so the permutation matrix tests the gate from tonight's forward walk onward.
#>
$ErrorActionPreference = 'Continue'
$repo = 'C:\Projects\open-shal-swarm-harness-agent-llm'
$logFile = Join-Path $env:LOCALAPPDATA 'oshal\earnings-gate-deploy.log'
function Log($m) { ("[{0}] {1}" -f (Get-Date -Format s), $m) | Add-Content $logFile; Write-Host $m }
function Notify($subject, $body) {
  docker exec oshal-local-api node /app/scripts/oshal-send-alert.js "$subject" "$body" 2>&1 | Out-String | ForEach-Object { Log ("email: " + $_.Trim()) }
}
function Bail($why) {
  Log ("ABORT: " + $why)
  Notify 'OSHAL earnings-gate deploy SKIPPED' ("The post-close earnings-gate deploy did NOT run: " + $why + " - re-run scripts/deploy-earnings-gate-once.ps1 manually or ask Claude.")
  schtasks /delete /tn "OSHAL Earnings Gate Deploy" /f 2>$null | Out-Null
  exit 1
}

Log '--- one-shot earnings-gate deploy starting ---'

# Guard 1: never before the close (defense against a mis-registered task time).
$et = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'Eastern Standard Time')
if ($et.Hour -lt 16) { Bail ("market not closed yet (ET " + $et.ToString('HH:mm') + ")") }

# Guard 2: the career scrape must not be running (operator rule: never recreate the api mid-scrape).
$scrape = docker exec oshal-local-api sh -c "pgrep -f jobhunter | head -1" 2>$null
if ($scrape) { Bail 'career-hunter scrape is running in the api (pgrep -f jobhunter matched)' }

# 1) Arm the gate for PAPER in .env (idempotent append; never touches an existing non-comment line).
$envPath = Join-Path $repo '.env'
$envRaw = Get-Content $envPath -Raw
if ($envRaw -match "(?m)^TRADING_EARNINGS_GATE=") {
  Log '.env already has TRADING_EARNINGS_GATE - leaving the existing value alone'
} else {
  Add-Content $envPath "`n# Earnings blackout: PAPER-ONLY soak (2026-07-17). Counterfactuals accrue in oshal_trading_gate_blocks; promote to 'both' only on scored evidence.`nTRADING_EARNINGS_GATE=paper"
  Log 'appended TRADING_EARNINGS_GATE=paper to .env'
}

# 2) Build the image from committed HEAD (bash for the binary pipe - PowerShell corrupts it).
Log 'building oshal-bot:latest from git archive HEAD...'
& "C:\Program Files\Git\bin\bash.exe" -lc "cd /c/Projects/open-shal-swarm-harness-agent-llm && git archive HEAD | docker build -f Dockerfile.oshal -t oshal-bot:latest -q -" 2>&1 | ForEach-Object { Log $_ }
$sym = docker run --rm --entrypoint sh oshal-bot:latest -c "grep -c 'recordGateBlocks' /app/dist/app/trading-schedule-dispatch.js" 2>$null
if (-not $sym -or [int]$sym -lt 1) { Bail 'built image does NOT contain recordGateBlocks - build failed or built stale source' }
Log ("image verified: recordGateBlocks x" + $sym)

# 3) Recreate the api on the new image + env.
Set-Location $repo
docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --no-deps oshal-api 2>&1 | ForEach-Object { Log $_ }

# 4) Wait healthy, then verify the running container.
$ok = $false
foreach ($i in 1..24) {
  Start-Sleep -Seconds 10
  $h = docker inspect oshal-local-api --format '{{.State.Health.Status}}' 2>$null
  if ($h -eq 'healthy') { $ok = $true; break }
}
if (-not $ok) { Bail 'api did not report healthy within 4 minutes of the recreate - CHECK THE STACK (scripts/oshal-up.sh)' }
$gateVal = docker exec oshal-local-api sh -c "printenv TRADING_EARNINGS_GATE" 2>$null
$runSym = docker exec oshal-local-api sh -c "grep -c 'recordGateBlocks' /app/dist/app/trading-schedule-dispatch.js" 2>$null
Log ("running container: TRADING_EARNINGS_GATE=" + $gateVal + ", recordGateBlocks x" + $runSym)
if ($gateVal -ne 'paper' -or [int]$runSym -lt 1) { Bail ("verification failed (gate='" + $gateVal + "', sym=" + $runSym + ")") }

# 5) Seed the earnings-gate A/B lab grid (8 twin rows) now that the api knows the knob. The seeder
# self-guards (assertApiKnowsEarningsGate) so a partial deploy cannot create fake twins; a failure
# here only delays the lab rows, never the gate itself.
Log 'seeding --grid egate twin rows...'
Set-Location $repo
$egateOut = npx ts-node --transpile-only scripts/oshal-trading-knob-sweep.ts --grid egate 2>&1 | Out-String
$egateOut -split "`n" | Select-Object -Last 3 | ForEach-Object { Log $_.Trim() }
$egateOk = $egateOut -match '"ok":true'

Notify 'OSHAL earnings gate LIVE on paper' ("Post-close deploy done: earnings blackout armed for the PAPER book only (TRADING_EARNINGS_GATE=paper), counterfactual ledger active (oshal_trading_gate_blocks). LIVE book unchanged. Lab A/B twins (egate/ grid): " + $(if ($egateOk) { 'seeded - forward-walking nightly beside their gate-off bases' } else { 'SEEDING FAILED - run: npx ts-node --transpile-only scripts/oshal-trading-knob-sweep.ts --grid egate' }) + ". First gated fires: Monday pre-open. Undo: remove the line from .env + recreate the api.")
Log '--- deploy complete ---'
schtasks /delete /tn "OSHAL Earnings Gate Deploy" /f 2>$null | Out-Null
exit 0
