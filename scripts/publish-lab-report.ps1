<#
  publish-lab-report.ps1 - nightly Strategy Lab report -> oswarm.ai/lab/ (operator ask 2026-07-17).

  Runs AFTER the lab's post-close forward walk (the 16:45 CT trading-lab leg): regenerates the
  static report from the lab api (site-lab-report.js), then ships it with the SAME staged +
  hash-verified deploy the site already uses (deploy-oswarm-site.sh). Generation failure = deploy
  SKIPPED (last night's page stays live; a broken/empty report never ships); only failures email.

  Register (weekdays 17:20 CT, windowless via the hidden launcher):
    schtasks /create /tn "OSHAL Lab Report Publish" /sc weekly /d MON,TUE,WED,THU,FRI /st 17:20 /f ^
      /tr "wscript.exe //B //Nologo C:\Projects\oshal\scripts\publish-lab-report-hidden.vbs"

  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - generate via site-lab-report.js, deploy via deploy-oswarm-site.sh, log to %LOCALAPPDATA%\oshal\lab-report-publish.log, email ONLY on failure.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Self-locating (ADR-115 trunk cutover): $repo derives from the script's own location instead of the hardcoded archive path - pointed at the archive, the nightly deploy would have overwritten the live site with the STALE pre-launch page every weekday. Cloudflare auth stays where it always was: wrangler's own profile config, never in the repo.
#>
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $env:LOCALAPPDATA 'oshal\lab-report-publish.log'
function Log($m) { ("[{0}] {1}" -f (Get-Date -Format s), $m) | Add-Content $logFile }
function FailMail($why) {
  Log ("FAILED: " + $why)
  docker exec oshal-local-api node /app/scripts/oshal-send-alert.js "OSHAL lab report publish FAILED" ("Tonight's strategy-lab report did not publish: " + $why + " - last night's page is still live at oswarm.ai/lab/. Re-run: powershell -File scripts/publish-lab-report.ps1") 2>&1 | Out-String | ForEach-Object { Log ("email: " + $_.Trim()) }
  exit 1
}

Log '--- nightly lab report publish starting ---'
Set-Location $repo

# 1) Generate. A non-zero exit means the lab/api was unreachable or empty - never deploy that.
$gen = node scripts/site-lab-report.js 2>&1 | Out-String
$gen -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { Log $_.Trim() }
if ($LASTEXITCODE -ne 0) { FailMail 'report generation failed (see lab-report-publish.log)' }

# 2) Deploy + prod-verify via the site's own gate. Repo path derived, never hardcoded.
$repoFwd = '/' + ($repo -replace ':', '' -replace '\\', '/').ToLower().Substring(0, 1) + ($repo -replace ':', '' -replace '\\', '/').Substring(1)
$dep = & "C:\Program Files\Git\bin\bash.exe" -lc "cd '$repoFwd' && bash scripts/deploy-oswarm-site.sh" 2>&1 | Out-String
$dep -split "`n" | Select-Object -Last 12 | Where-Object { $_.Trim() } | ForEach-Object { Log $_.Trim() }
if ($LASTEXITCODE -ne 0) { FailMail 'site deploy/verify failed (see lab-report-publish.log)' }

Log '--- published + verified ---'
exit 0
