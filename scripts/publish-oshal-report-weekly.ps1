<#
  publish-oshal-report-weekly.ps1 - generate + publish the weekly oshal report post.

  The weekly write-up used to be hand-authored, so it froze the moment nobody remembered it (found
  a week stale on 2026-07-31, still headlined "week of July 17-24" while the daily pipeline had been
  publishing every session beneath it). Everything on the page now comes from a ledger or from the
  strategy journal, and this script is what puts it there.

  Runs the generator INSIDE the api container (it needs DATABASE_URL), counts the app-store commits
  HERE on the host (that repo is not mounted in the container), copies the page into the site repo,
  commits, pushes and deploys through the site's own gate.

  Register (Fridays 18:00 CT, windowless):
    schtasks /create /tn "OSHAL Weekly Report" /sc weekly /d FRI /st 18:00 /f ^
      /tr "wscript.exe //B //Nologo C:\Projects\oshal\scripts\publish-oshal-report-weekly-hidden.vbs"

  Usage: publish-oshal-report-weekly.ps1 [-Through YYYY-MM-DD] [-Days 7] [-SkipDeploy]

  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ | AUTHOR                                     | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - generate via site-oshal-report.js, publish to the site, alert on failure.
#>
[CmdletBinding()]
param(
  [string]$Through,
  [int]$Days = 7,
  [string]$SiteRepo = 'C:\Projects\agenticfederal',
  [string]$AppsRepo = 'C:\Projects\oshal-applications',
  [switch]$SkipDeploy
)
# NOT 'Stop': docker/git/wrangler write progress to stderr, which Stop + 2>&1 turns into a
# terminating NativeCommandError in PS 5.1. Real failures are gated explicitly below.
$ErrorActionPreference = 'Continue'
if (-not $Through) { $Through = (Get-Date).ToString('yyyy-MM-dd') }
$logFile = Join-Path $env:LOCALAPPDATA 'oshal\weekly-report.log'
New-Item -ItemType Directory -Force (Split-Path $logFile) | Out-Null
function Note($m) { ("[{0}] {1}" -f (Get-Date -Format s), $m) | Tee-Object -FilePath $logFile -Append | Write-Host }
function Fail($m) {
  Note "FAILED: $m"
  try {
    docker exec oshal-local-api node /app/scripts/oshal-send-alert.js "OSHAL weekly report FAILED ($Through)" ("The weekly oshal report did not publish: " + $m + " - see " + $logFile + ". Re-run: powershell -File scripts/publish-oshal-report-weekly.ps1 -Through " + $Through) 2>&1 | Out-String | ForEach-Object { Note ("alert: " + $_.Trim()) }
  } catch { Note "alert email also failed: $($_.Exception.Message)" }
  exit 1
}
Note "=== weekly oshal report through $Through ($Days days) ==="

# 1) Count app-store commits HERE - the container cannot see that repo.
$since = (Get-Date $Through).AddDays(-($Days - 1)).ToString('yyyy-MM-dd')
$until = (Get-Date $Through).AddDays(1).ToString('yyyy-MM-dd')
$commits = 0
if (Test-Path $AppsRepo) {
  $commits = (& git -C $AppsRepo log --oneline "--since=$since`T00:00:00" "--until=$until`T00:00:00" 2>$null | Measure-Object).Count
  Note "app-store commits $since..$Through : $commits"
} else { Note "app-store repo not found at $AppsRepo - the commit stat will be omitted" }

# 2) Generate inside the container (needs DATABASE_URL + the journal).
$sub = $env:OSHAL_USER_SUB
if (-not $sub) { Fail 'OSHAL_USER_SUB not set in this shell - the journal and ledger queries are user-scoped and would return nothing' }
$genArgs = @('exec', '-e', "OSHAL_USER_SUB=$sub", 'oshal-local-api', 'node', '/app/scripts/site-oshal-report.js',
             "--through=$Through", "--days=$Days", '--out=/tmp/oshal-report.html')
if ($commits -gt 0) { $genArgs += "--commits=$commits" }
$gen = & docker @genArgs 2>&1 | Out-String
$gen -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { Note $_.Trim() }
if ($gen -notmatch 'OSHAL_REPORT_OK') { Fail 'generator did not report OK (see log)' }

# 3) Copy out + sanity-check before it can reach the site.
$dest = Join-Path $SiteRepo 'blog\oshal-report.html'
docker cp oshal-local-api:/tmp/oshal-report.html $dest 2>&1 | Out-Null
if (-not (Test-Path $dest)) { Fail 'generated page did not copy out of the container' }
$html = Get-Content $dest -Raw
if ($html.Length -lt 2000) { Fail "generated page is suspiciously small ($($html.Length) bytes) - refusing to publish" }
if ($html -notmatch 'The oshal report') { Fail 'generated page is missing its own title - refusing to publish' }

# 4) Publish (trunk, explicit pathspec).
git -C $SiteRepo switch main | Out-Null
git -C $SiteRepo pull --rebase 2>&1 | ForEach-Object { Note $_ }
git -C $SiteRepo add blog/oshal-report.html
$staged = git -C $SiteRepo diff --cached --name-only
if (-not $staged) { Note 'no change in the weekly page this run'; exit 0 }
git -C $SiteRepo commit -q -m "blog: the oshal report - week through $Through (generated)" -- blog/oshal-report.html
if ($LASTEXITCODE -ne 0) { Fail 'git commit failed' }
git -C $SiteRepo push | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'git push failed (check GitHub creds)' }
Note 'pushed to GitHub'

if (-not $SkipDeploy) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SiteRepo 'scripts\deploy-cloudflare-pages.ps1') 2>&1 | Select-Object -Last 3 | ForEach-Object { Note $_ }
  if ($LASTEXITCODE -ne 0) { Fail 'wrangler deploy failed' }
  # VERIFY prod carries this week's page before claiming success.
  $ok = $false
  for ($i = 0; $i -lt 6; $i++) {
    try {
      $live = (Invoke-WebRequest "https://agenticfederal.us/blog/oshal-report?cb=$(Get-Random)" -TimeoutSec 20 -UseBasicParsing).Content
      if ($live -match [regex]::Escape((Get-Date $Through).ToString('yyyy'))) { $ok = $true; break }
    } catch { }
    Start-Sleep -Seconds 10
  }
  if (-not $ok) { Fail 'prod verify: the weekly page did not come back after deploy' }
  Note 'VERIFIED live'
}
Note "=== DONE: weekly report through $Through ==="
