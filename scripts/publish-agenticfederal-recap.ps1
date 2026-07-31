<#
  publish-agenticfederal-recap.ps1 - publish the day's trade recap to agenticfederal.us.

  Pull the site repo (GitHub creds via git credential manager), drop the dated artifacts into
  media/recaps/, prepend the entry into index.json (idempotent - re-running a day replaces its
  entry), refresh the featured-player fallback files, commit + push, deploy via the site's
  wrangler script (Cloudflare OAuth), then VERIFY prod serves the new video before claiming
  success. The site pages are data-driven off index.json (recap-live.js + the blog post), so
  no HTML is edited here - files + one JSON prepend update the trading page, the blog post,
  and the archive together.

  Usage: publish-agenticfederal-recap.ps1 -Date YYYY-MM-DD [-SiteRepo path] [-SkipDeploy]
  Exit 0 = published + verified. Non-zero = the real error printed (caller surfaces it).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Date,
  [string]$SiteRepo = 'C:\Projects\agenticfederal',
  [string]$Out = 'C:\Projects\open-shal-swarm-harness-agent-llm\packages\oshal-vids-operator\out',
  [switch]$SkipDeploy
)
# NOT 'Stop': git/wrangler write progress to stderr, which Stop + 2>&1 turns into a terminating
# NativeCommandError in PowerShell 5.1. Real failures are gated on $LASTEXITCODE via Fail().
$ErrorActionPreference = 'Continue'
function Note($m) { Write-Host ("[publish-af] " + $m) }
function Fail($m) { Write-Host ("[publish-af] FAILED: " + $m); exit 1 }
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') { Fail "bad -Date '$Date' (want YYYY-MM-DD)" }

# 1) Source artifacts must exist (the day's finished pieces on this host).
$video = Join-Path $Out 'trade-recap.mp4'
$deck  = Join-Path $Out 'deck.pptx'
$pdf   = Join-Path $Out "$Date.pdf"
if (-not (Test-Path $video) -or (Get-Item $video).Length -lt 1MB) { Fail "no/short $video" }
if (-not (Test-Path $deck)) { Fail "missing $deck" }
if (-not (Test-Path $pdf))  { Fail "missing $pdf" }
$deckData = Get-Content (Join-Path $Out 'deck-data.json') -Raw | ConvertFrom-Json
if ($deckData.date) { $label = $deckData.date } else { $label = $Date }

# 2) Sync the site repo (trunk, no branches - same rule as everywhere).
Note "pulling $SiteRepo..."
git -C $SiteRepo switch main | Out-Null
git -C $SiteRepo pull --rebase | ForEach-Object { Note $_ }
if ($LASTEXITCODE -ne 0) { Fail "git pull --rebase failed in $SiteRepo" }

# 3) Dated artifacts into media/recaps/ (same-day overwrite OK - that's a republish of a fix).
$recapsDir = Join-Path $SiteRepo 'media\recaps'
Copy-Item $video (Join-Path $recapsDir "$Date.mp4")  -Force
Copy-Item $deck  (Join-Path $recapsDir "$Date.pptx") -Force
Copy-Item $pdf   (Join-Path $recapsDir "$Date.pdf")  -Force
# Featured-player no-JS fallback files (recap-live.js retargets JS visitors at the dated copy).
Copy-Item $video (Join-Path $SiteRepo 'media\trade-recap.mp4')       -Force
Copy-Item $deck  (Join-Path $SiteRepo 'media\trade-recap-deck.pptx') -Force

# 4) Prepend into index.json (idempotent: drop any existing entry for this date first).
$idxPath = Join-Path $recapsDir 'index.json'
$idx = Get-Content $idxPath -Raw | ConvertFrom-Json
$entry = [ordered]@{ date = $Date; label = $label; deck = "recaps/$Date.pptx"; video = "recaps/$Date.mp4"; pdf = "recaps/$Date.pdf" }
$rest = @($idx.recaps | Where-Object { $_.date -ne $Date })
$idx = @{ recaps = @($entry) + $rest }
# BOM-less UTF-8: PS 5.1's Set-Content -Encoding utf8 writes a BOM, which strict JSON parsers reject.
[System.IO.File]::WriteAllText($idxPath, ($idx | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Note "index.json: $Date prepended ($(@($idx.recaps).Count) sessions)"

# 5) Commit + push (explicit pathspecs; nothing else in the tree gets swept in).
git -C $SiteRepo add media/recaps media/trade-recap.mp4 media/trade-recap-deck.pptx | Out-Null
$staged = git -C $SiteRepo diff --cached --name-only
if ($staged) {
  git -C $SiteRepo commit -q -m "recap $Date - daily trade recap video + deck + report"
  if ($LASTEXITCODE -ne 0) { Fail "git commit failed" }
  git -C $SiteRepo push | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "git push failed (check GitHub creds)" }
  Note "pushed to GitHub"
} else {
  Note "no media changes to commit"
  # A prior commit (e.g. site-page changes) may still be waiting - push regardless.
  git -C $SiteRepo push | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "git push failed (check GitHub creds)" }
}

# 6) Deploy via the site's own wrangler script (stages public files, wrangler pages deploy).
if (-not $SkipDeploy) {
  Note "deploying to Cloudflare Pages..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SiteRepo 'scripts\deploy-cloudflare-pages.ps1')
  if ($LASTEXITCODE -ne 0) { Fail "wrangler deploy failed" }
} else { Note "-SkipDeploy set; not deploying" }

# 7) VERIFY prod before claiming success (allow ~60s CF propagation).
if (-not $SkipDeploy) {
  $url = "https://agenticfederal.us/media/recaps/$Date.mp4"
  $ok = $false
  for ($i = 0; $i -lt 6; $i++) {
    try {
      $r = Invoke-WebRequest -Method Head -Uri $url -TimeoutSec 15 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
    Start-Sleep -Seconds 10
  }
  if (-not $ok) { Fail "prod verify: $url not returning 200 after deploy" }
  $idxOk = $false
  for ($i = 0; $i -lt 6; $i++) {
    try {
      # Cache-bust: the CF edge holds the prior deploy's copy briefly; a plain GET can read stale.
      $raw = (Invoke-WebRequest "https://agenticfederal.us/media/recaps/index.json?cb=$(Get-Random)" -TimeoutSec 15 -UseBasicParsing).Content
      $j = $raw.TrimStart([char]0xFEFF) | ConvertFrom-Json   # tolerate a BOM from older deploys
      if (@($j.recaps)[0].date -eq $Date) { $idxOk = $true; break }
    } catch { }
    Start-Sleep -Seconds 10
  }
  if (-not $idxOk) { Fail "prod verify: index.json does not lead with $Date after deploy" }
  Note "VERIFIED: $url is live and index.json leads with $Date"
}

# 8) MIRROR to the company site. This step did not exist until 2026-07-31, so emeraldcoastsystemsgroup
# .com/demos only ever moved when someone updated it BY HAND - it sat on the July 24 session while
# agenticfederal was publishing nightly, and the operator found it a week stale. A second surface that
# only a human remembers to update is a surface that is always wrong. Mirroring failure is NOTED, never
# fatal: the primary site is already published and verified above, and a company-site hiccup must not
# fail the nightly run behind it.
try {
  $mirror = Join-Path $PSScriptRoot 'publish-ecsg-recap.ps1'
  if (Test-Path $mirror) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $mirror -Date $Date -Out $Out 2>&1 | ForEach-Object { Note $_ }
    if ($LASTEXITCODE -ne 0) { Note "company-site mirror FAILED (agenticfederal is published + verified; re-run publish-ecsg-recap.ps1 -Date $Date)" }
  } else { Note "company-site mirror script not found at $mirror - skipped" }
} catch { Note "company-site mirror error: $($_.Exception.Message)" }

Note "DONE: $Date published to agenticfederal.us"
