<#
  publish-ecsg-recap.ps1 - mirror the day's trade recap onto the company site (demos page).

  The company site hosts its OWN copies under /downloads/recaps/ and reads /js/recaps.json, so it
  is a genuine second publish, not a link to the primary site. Before 2026-07-31 nothing automated
  touched it: the demos page advertised "Latest session - July 24" while agenticfederal had been
  publishing nightly for a week. Any surface that only updates when a human remembers is a surface
  that is eventually wrong, so the nightly publisher now calls this.

  Deploy model is PUSH-TO-MAIN (the site builds from the repo). Never `npm run deploy` here.

  Usage: publish-ecsg-recap.ps1 -Date YYYY-MM-DD [-SiteRepo path] [-Out path] [-SkipPush]
  Exit 0 = mirrored (and pushed unless -SkipPush). Non-zero = the real error printed.

  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ | AUTHOR                                     | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - mirror dated video/pdf into downloads/recaps, upsert js/recaps.json sorted newest-first, commit + push. Carries the honesty note through so a numbers-only day reads the same on both surfaces.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Date,
  [string]$SiteRepo = 'C:\Projects\emeraldcoastsystemsgroup',
  [string]$Out = 'C:\Projects\open-shal-swarm-harness-agent-llm\packages\oshal-vids-operator\out',
  [string]$Note,
  [switch]$SkipPush
)
# NOT 'Stop': git writes progress to stderr, which Stop + 2>&1 turns into a terminating
# NativeCommandError in PowerShell 5.1. Real failures are gated explicitly below.
$ErrorActionPreference = 'Continue'
function Note2($m) { Write-Host ("[publish-ecsg] " + $m) }
function Fail($m) { Write-Host ("[publish-ecsg] FAILED: " + $m); exit 1 }
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') { Fail "bad -Date '$Date' (want YYYY-MM-DD)" }
if (-not (Test-Path $SiteRepo)) { Fail "site repo not found: $SiteRepo" }

# 1) What do we have for this day? A video is OPTIONAL - a numbers-only day still publishes.
$video = Join-Path $Out 'trade-recap.mp4'
$pdf   = Join-Path $Out "$Date.pdf"
if (-not (Test-Path $pdf)) { Fail "missing $pdf - nothing to mirror" }
$hasVideo = (Test-Path $video) -and ((Get-Item $video).Length -gt 1MB)

$recapsDir = Join-Path $SiteRepo 'downloads\recaps'
New-Item -ItemType Directory -Force $recapsDir | Out-Null
Copy-Item $pdf (Join-Path $recapsDir "$Date.pdf") -Force
if ($hasVideo) { Copy-Item $video (Join-Path $recapsDir "$Date.mp4") -Force }

# 2) Label from the day's own deck data when available (keeps both sites phrased identically).
$label = ([datetime]$Date).ToString('MMMM d, yyyy')
$deckDataPath = Join-Path $Out 'deck-data.json'
if (Test-Path $deckDataPath) {
  try { $dd = Get-Content $deckDataPath -Raw | ConvertFrom-Json; if ($dd.date) { $label = $dd.date } } catch { }
}

# 3) Upsert into js/recaps.json, SORTED newest-first (never a blind prepend - a backfilled older
# date has to land in its right place, not on top).
$idxPath = Join-Path $SiteRepo 'js\recaps.json'
if (-not (Test-Path $idxPath)) { Fail "missing $idxPath" }
$idx = Get-Content $idxPath -Raw | ConvertFrom-Json
$entry = [ordered]@{ date = $Date; label = $label; deck = "/downloads/recaps/$Date.pdf" }
if ($hasVideo) { $entry.video = "/downloads/recaps/$Date.mp4" }
if ($Note) { $entry.note = $Note }
$rest = @($idx.recaps | Where-Object { $_.date -ne $Date })
$all = @(@([pscustomobject]$entry) + $rest | Sort-Object -Property date -Descending)
# BOM-less UTF-8: PS 5.1's Set-Content -Encoding utf8 writes a BOM that strict JSON parsers reject.
[System.IO.File]::WriteAllText($idxPath, ([pscustomobject]@{ recaps = $all } | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Note2 "recaps.json: $Date upserted ($(@($all).Count) sessions, leads with $(@($all)[0].date))"

# 4) Commit + push with explicit pathspecs so nothing else in the tree is swept in.
$paths = @("downloads/recaps/$Date.pdf", 'js/recaps.json')
if ($hasVideo) { $paths += "downloads/recaps/$Date.mp4" }
git -C $SiteRepo add @paths
$staged = git -C $SiteRepo diff --cached --name-only
if (-not $staged) { Note2 "nothing changed for $Date - already mirrored"; exit 0 }
$msg = "demos: $label report" + $(if ($hasVideo) { " - narrated video + deck" } else { " - numbers + deck" })
git -C $SiteRepo commit -q -m $msg -- @paths
if ($LASTEXITCODE -ne 0) { Fail 'git commit failed' }
if ($SkipPush) { Note2 '-SkipPush set; committed but not pushed'; exit 0 }
git -C $SiteRepo push | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'git push failed (check GitHub creds)' }
Note2 "DONE: $Date mirrored to the company site"
