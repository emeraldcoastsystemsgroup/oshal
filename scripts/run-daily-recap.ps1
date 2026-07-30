<#
  run-daily-recap.ps1 — the daily driver (validated 2026-07-02). Post-close, this:
    1. PREFLIGHT: confirm the render node is online + its debug Chrome is signed into Vids.
    2. DATA:   generate the day's numbers (oshal-trade-data.js -> oshal-deck-data.js in the api
               container, which has the DB + Alpaca env) and build the deck (make-deck-detailed.py).
    3. STAGE:  push deck-data.json + deck.pptx (+ one-time presenter-head.png) and the build GOAL to the node.
    4. BUILD:  launch the node's local claude agent on RECAP-BUILD-GOAL.md (3 fresh-video presenter clips +
               Google Convert-Slides narrated deck). COLD-START RETRY: if it produces nothing in ~5 min,
               kill + relaunch once. Poll BUILD.done / BUILD.err.
    5. COLLECT: pull the 4 pieces (long per-piece timeout — chunked transfers take minutes), verify each
               is FRESH (written this run — a stale prior-day piece must never assemble into today's video),
               assemble on the host (assemble-recap.js -> trade-recap.mp4), render the PDF.
    6. ARCHIVE: commit the day into the finance-history git repo. We do NOT publish — the operator wrangles that.
  The api :35457 event loop hangs periodically; every node call auto-restarts it on ECONNRESET and retries.
  Any hard failure writes a note + an ALERT EMAIL (oshal-send-alert.js) so a miss is never silent —
  a blocking desktop dialog is useless to an unattended nightly (2026-07-28: two weeks of misses hid
  behind exactly that). The runner also writes ops-notes.json (lateness, api restarts, watchdog
  recoveries) which the deck generator folds into the report's "What changed / Operations" section.

  Usage: run-daily-recap.ps1 [-Date YYYY-MM-DD] [-Node <clientId>] [-SkipData]

  CHANGE LOG  (started 2026-07-30 — this file predates the convention; earlier history is in git)
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Verify node transfers AT the transfer. NodePush/NodePull piped RN's output to Out-Null, and RN returns its last output after exhausting retries - so a transfer that never landed was indistinguishable from one that did. On 2026-07-30 the four piece pulls ran 26 minutes, reported nothing, and handed the assembler a prior day's deck-narrated.mp4; the step-5 freshness gate caught it (correctly) but only after the whole window was spent, and the operator got a failure that named a stale file rather than the dead transfer that caused it. Each helper now checks the driver's failure text and then the file it was supposed to produce - existence, and that the local copy actually changed. The step-5 freshness gate stays: it covers the different case of a remote piece that is itself stale.
#>
[CmdletBinding()]
param(
  [string]$Date,
  [string]$Node    = 'oshal-chat-0ce849b6-8b95-4cf5-9223-ce22d638f1c9',  # render-node-1 @ localhost
  [string]$NodeOut = 'C:\oshal-vidsop\out',
  [switch]$SkipData,
  [switch]$SkipBuild   # reuse the pieces already on the node (skip the ~40-min generation)
)
# NOT 'Stop': native commands (node/docker) write progress to stderr which, under Stop + 2>&1,
# PowerShell 5.1 turns into a terminating NativeCommandError. We gate real failures with Fail() checks.
$ErrorActionPreference = 'Continue'
# Operator-local paths come from env (the repo ships placeholders only): OSHAL_RECAP_REPO is the
# working tree holding the vids-operator assets/out, OSHAL_FFMPEG the ffmpeg binary.
$REPO    = if ($env:OSHAL_RECAP_REPO) { $env:OSHAL_RECAP_REPO } else { 'C:\Projects\open-shal-swarm-harness-agent-llm' }
$OUT     = Join-Path $REPO 'packages\oshal-vids-operator\out'
$FINREPO = if ($env:OSHAL_FINREPO) { $env:OSHAL_FINREPO } else { 'C:\Projects\finance-history' }
$GOAL    = Join-Path $REPO 'packages\oshal-vids-operator\RECAP-BUILD-GOAL.md'
# The remote-node driver comes from THIS script's own repo, not $REPO. $REPO still points at the
# pre-cutover archive for the vids-operator assets, and the archive's copy of the driver never
# received the 2026-07-28 chunk-window fix or the 2026-07-30 quadratic-pull fix — so every fix
# landed in the trunk and the nightly kept running the old code. Fall back only if it is absent.
$RNJS    = if (Test-Path "$PSScriptRoot\codex-remote-node.mjs") { "$PSScriptRoot\codex-remote-node.mjs" } else { "$REPO\scripts\codex-remote-node.mjs" }
$FF      = if ($env:OSHAL_FFMPEG) { $env:OSHAL_FFMPEG } else { 'ffmpeg' }
if (-not $Date) { $Date = (Get-Date).ToUniversalTime().AddHours(-5).ToString('yyyy-MM-dd') }  # ET calendar date
$parent = Split-Path $NodeOut   # the node's vids-operator root, e.g. C:\oshal-vidsop
$log = Join-Path $FINREPO ("run-" + $Date + ".log")
$runStart = Get-Date
function Note($m){ ("[{0}] {1}" -f (Get-Date -Format s), $m) | Tee-Object -FilePath $log -Append | Write-Host }
# FAIL LOUD: email the operator via the platform's own alert rail. Never a blocking dialog — an
# unattended scheduled run has nobody to click OK, and a hidden dialog holds the process forever.
function Fail($m){
  Note "FAILED: $m"
  try {
    docker exec oshal-local-api node /app/scripts/oshal-send-alert.js "OSHAL daily recap FAILED ($Date)" ("The nightly trade recap did not complete: " + $m + " - see " + $log + ". Re-run: powershell -File scripts/run-daily-recap.ps1 -Date " + $Date) 2>&1 | Out-String | ForEach-Object { Note ("alert: " + $_.Trim()) }
  } catch { Note "alert email also failed: $($_.Exception.Message)" }
  exit 1
}
function RestartApi(){ Note "api hung -> restarting oshal-local-api"; docker restart oshal-local-api | Out-Null; for($i=0;$i -lt 30;$i++){ try{ if((Invoke-WebRequest 'http://127.0.0.1:35457/api/health' -TimeoutSec 5 -UseBasicParsing).StatusCode -eq 200){ Start-Sleep 28; return } }catch{}; Start-Sleep 4 } }
# Run a codex-remote-node subcommand from the repo cwd (so .env is found). Simple retry on a
# transient reset — a short wait, NOT an api restart (restarting knocks the node out of the
# in-memory registry and loops). If the api is genuinely down, the caller's health guard restarts it.
function RN([string[]]$rnArgs){
  for($try=0;$try -lt 4;$try++){
    $out = & node $RNJS @rnArgs 2>&1 | Out-String
    if ($out -notmatch 'ECONNRESET|fetch failed|timed out') { return $out }
    Note "node call transient (retry $try)"; Start-Sleep -Seconds 10
  }
  return $out
}
function NodeShell($psFile,[int]$t=45000){ RN @('shell', "--client=$Node", "--timeoutMs=$t", "--cmdFile=$psFile") }
# A transfer that never landed used to be INVISIBLE. RN returns its last output after exhausting
# its retries, and both helpers piped that straight to Out-Null — so a dead transfer and a good
# one were the same thing to every caller. On 2026-07-30 four piece pulls "succeeded" over 26
# minutes and handed the assembler a PRIOR DAY's deck-narrated.mp4; only the freshness gate at
# step 5 noticed, 26 minutes late. Verify AT the transfer instead: the driver's own failure text,
# then the file the transfer was supposed to produce.
function LastLine($s){ $l = ($s -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1); if ($l) { $l.Trim() } else { '(no output)' } }
# 'FAIL:' is how the driver reports its own hard errors (die()) — including a truncated chunk,
# which must never be spliced into a file. Matching it here means a driver-side abort is caught
# by the same path as a transport error rather than falling through as an apparent success.
function TransferFailed($out){ return ($out -match 'ECONNRESET|fetch failed|timed out|ENOENT|no such file|FAIL:') }
function NodePush($local,$remote){
  $out = RN @('push', "--client=$Node", "--local=$local", "--remote=$remote")
  if (TransferFailed $out) { Fail ("push FAILED for " + (Split-Path $local -Leaf) + " -> " + $Node + ": " + (LastLine $out)) }
}
# Pulls are CHUNKED and take minutes for a video piece; the driver's default 30s result window
# guarantees a "timed out" no matter how healthy the node is (root-caused 2026-07-28 — every
# nightly piece pull was structurally doomed). Wait long enough for the transfer to finish.
function NodePull($remote,$local){ $name = Split-Path $remote -Leaf
  $before = if (Test-Path $local) { (Get-Item $local).LastWriteTime } else { [datetime]::MinValue }
  $out = RN @('pull', "--client=$Node", "--timeoutMs=600000", "--remote=$remote", "--local=$local")
  if (TransferFailed $out) { Fail ("pull FAILED for $name from $Node - " + (LastLine $out) + " (a locked or blank desktop session on the node looks exactly like this)") }
  if (-not (Test-Path $local)) { Fail "pull of $name reported no error but produced no local file" }
  if ((Get-Item $local).LastWriteTime -le $before) { Fail "pull of $name did not refresh the local copy - the transfer silently no-opped, leaving the prior day's file on disk" }
}

Set-Location $REPO   # so `node scripts\codex-remote-node.mjs` finds .env (REMOTE_CLIENT_SHARED_SECRET)
# 127.0.0.1, never 'localhost': a stale wslrelay can squat the IPv6 loopback [::1] on the published
# port, so 'localhost' fails while the api is perfectly healthy on IPv4. That false signal is what
# drove a night of pointless api restarts (2026-07-28), each one killing an in-flight node transfer.
#
# BE PATIENT BEFORE RESTARTING. Restarting the api is not free: it drops the render node from the
# in-memory registry, which then fails preflight. And the api's own boot fires a burst of parallel
# DB work that can make /api/health answer slower than a 6s probe — so an impatient check restarts
# a booting api, causing another slow boot, and so on (observed 2026-07-29: three restarts in
# twenty minutes, all self-inflicted). Probe generously, and only restart if it is really wedged.
$apiOk = $false
for ($h = 0; $h -lt 6; $h++) {
  try { if ((Invoke-WebRequest 'http://127.0.0.1:35457/api/health' -TimeoutSec 15 -UseBasicParsing).StatusCode -eq 200) { $apiOk = $true; break } } catch {}
  Start-Sleep -Seconds 10
}
if (-not $apiOk) { RestartApi }
Note "=== daily recap $Date on node $Node ($NodeOut) ==="

# 1) PREFLIGHT — prune stray Chrome on the node, then OPEN a Vids tab (a prior build closes its
# tabs) and confirm it loads signed-in (no login redirect). The prune matters: 2026-07-28 the node
# hit its Windows commit limit under 88 accumulated Chrome processes and the build crawled for two
# hours — freeing the non-automation Chrome instances recovered 14.5GB on the spot. Only processes
# WITHOUT the oshal-video-chrome profile in their command line are touched; the signed-in debug
# instance driving Vids is never killed.
$pf = Join-Path $env:TEMP 'recap-preflight.ps1'
@'
$all = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
$stray = @($all | Where-Object { $_.CommandLine -notmatch 'oshal-video-chrome' })
$stray | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
'CHROME_PRUNED='+$stray.Count
foreach ($m in @('PUT','GET')) { try { Invoke-WebRequest -Method $m 'http://localhost:9222/json/new?https://docs.google.com/videos/u/0/' -TimeoutSec 8 -UseBasicParsing | Out-Null; break } catch {} }
Start-Sleep -Seconds 6
try {
  $v=(Invoke-WebRequest 'http://localhost:9222/json' -TimeoutSec 6 -UseBasicParsing).Content|ConvertFrom-Json
  'VIDS_SIGNED_IN='+[bool]($v|Where-Object{$_.type -eq 'page' -and $_.url -match 'docs.google.com/videos' -and $_.url -notmatch 'accounts.google.com|signin|ServiceLogin'})
} catch { 'CHROME_9222_DOWN' }
'@ | Set-Content $pf -Encoding ascii
# A node we cannot REACH is not a node that is signed out. Treating the two the same emailed the
# operator "go sign in on the render box" when Chrome was perfectly healthy and the api had simply
# been restarted a moment earlier, dropping the node from its in-memory registry (2026-07-29). Only
# a definitive answer FROM the node decides; anything else is transport and gets waited out.
$pfOut = $null
for ($pfTry = 0; $pfTry -lt 6; $pfTry++) {
  $pfOut = NodeShell $pf 45000
  if ($pfOut -match 'VIDS_SIGNED_IN=|CHROME_9222_DOWN') { break }
  Note "preflight: no answer from the node yet (attempt $($pfTry + 1)/6) - the api may still be re-registering it"
  Start-Sleep -Seconds 20
}
if ($pfOut -match 'CHROME_PRUNED=(\d+)') { Note ("preflight: pruned " + $Matches[1] + " stray Chrome process(es) on the node") }
if ($pfOut -notmatch 'VIDS_SIGNED_IN=|CHROME_9222_DOWN') { Fail "could not reach the render node $Node after 6 preflight attempts (transport, not the node's browser - check the api and the node's OSHAL Node app)" }
if ($pfOut -notmatch 'VIDS_SIGNED_IN=True') { Fail "node not ready (Chrome not up / not signed into Vids on :9222). Sign in on $Node, then re-run." }

# 2) DATA (in the api container)
if (-not $SkipData) {
  # SESSION GUARD — only recap real trading days. A weekend/holiday has no close to report,
  # and running anyway produces a bogus "day" from whatever data is lying around.
  $cal = docker exec oshal-local-api node /run/desktop/mnt/host/c/Projects/open-shal-swarm-harness-agent-llm/scripts/alpaca-is-session.js $Date 2>&1 | Out-String
  if ($cal -match 'NO_SESSION') { Note "no market session on $Date (weekend/holiday) - nothing to recap"; exit 0 }
  if ($cal -notmatch 'SESSION') { Note "session check inconclusive ($($cal.Trim())) - proceeding" }
  # OPS HONESTY — what the platform observed since the last report, written where the deck
  # generator can fold it into the "What changed / Operations" section (date-guarded there).
  $opsNotes = @()
  try { $st = [datetime](docker inspect oshal-local-api --format '{{.State.StartedAt}}' 2>$null); if ($st -gt (Get-Date).AddHours(-24)) { $opsNotes += ("api container restarted at " + $st.ToLocalTime().ToString('HH:mm') + " local (uptime under 24h)") } } catch {}
  try {
    $wdLog = Join-Path $env:LOCALAPPDATA 'oshal\oshal-stack-watchdog.log'
    if (Test-Path $wdLog) {
      $today = (Get-Date).ToString('yyyy-MM-dd'); $yday = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
      $recov = @(Select-String -Path $wdLog -Pattern 'RECOVERY SUCCEEDED' | Where-Object { $_.Line -match [regex]::Escape($today) -or $_.Line -match [regex]::Escape($yday) })
      if ($recov.Count -gt 0) { $opsNotes += ("stack watchdog ran " + $recov.Count + " recovery cycle(s) in the last two days") }
    }
  } catch {}
  try {
    $prevLog = Get-ChildItem $FINREPO -Filter 'run-*.log' | Where-Object { $_.Name -ne (Split-Path $log -Leaf) } | Sort-Object Name -Descending | Select-Object -First 1
    if ($prevLog -and (Select-String -Path $prevLog.FullName -Pattern 'FAILED:' -Quiet)) { $opsNotes += ("previous report run (" + $prevLog.BaseName.Replace('run-','') + ") logged a failure - see its log") }
  } catch {}
  $lateMin = [int]((Get-Date) - (Get-Date -Hour 17 -Minute 0 -Second 0)).TotalMinutes
  if ($lateMin -gt 30) { $opsNotes += ("tonight's report started " + $lateMin + " minutes after the 5:00 PM schedule") }
  @{ date = $Date; notes = $opsNotes } | ConvertTo-Json | Set-Content "$OUT\ops-notes.json" -Encoding utf8
  docker cp "$OUT\ops-notes.json" "oshal-local-api:/app/packages/oshal-vids-operator/out/ops-notes.json" 2>&1 | Out-Null

  Note "generating numbers + deck…"
  # OSHAL_USER_SUB comes from the operator's host env — the api container deliberately doesn't
  # carry it (public-trunk sanitization). Without it the generator's equity-store query matches
  # nothing and the headline P/L ships as honest nulls (that exact miss ran unnoticed for a week).
  $SubArgs = @(); if ($env:OSHAL_USER_SUB) { $SubArgs = @('-e', "OSHAL_USER_SUB=$($env:OSHAL_USER_SUB)") }
  docker exec @SubArgs oshal-local-api node /app/scripts/oshal-trade-data.js $Date 2>&1 | Out-Null
  docker exec @SubArgs oshal-local-api node /app/scripts/oshal-deck-data.js  $Date 2>&1 | Out-Null
  docker cp "oshal-local-api:/app/packages/oshal-vids-operator/out/deck-data.json"  "$OUT\deck-data.json"  2>&1 | Out-Null
  # recap-data.json is written INSIDE the container (/app) by oshal-trade-data.js; copy it back
  # too so the HOST copy can never go stale (a frozen host copy mislabeled the 07-06 email June 30).
  docker cp "oshal-local-api:/app/packages/oshal-vids-operator/out/recap-data.json" "$OUT\recap-data.json" 2>&1 | Out-Null
  if (-not (Test-Path "$OUT\deck-data.json")) { Fail "deck-data.json not produced" }
  # ASSERT THE ARTIFACT, not the inputs. A generator that runs without the date argument silently
  # reports YESTERDAY, and one that runs without OSHAL_USER_SUB silently reports a null P/L against
  # Alpaca's live equity instead of our own close store. Both look like success and both did ship
  # (2026-07-29: a hand relaunch from a shell lacking the user-level env var built a July-28 deck
  # with no P/L, and the build agent was already running on it before anyone noticed). Whatever the
  # cause, the day's own deck must name the day and carry a real number, or we do not build a video.
  $dd = Get-Content "$OUT\deck-data.json" -Raw | ConvertFrom-Json
  $wantLabel = ([datetime]$Date).ToString('MMMM d, yyyy')
  if ($dd.date -ne $wantLabel) { Fail "deck-data.json is for '$($dd.date)' but this report is $wantLabel - the generator ran without its date argument; refusing to build a mislabeled report" }
  if ($null -eq $dd.results.pl) { Fail "deck-data.json has a NULL day P/L (equity store returned nothing - OSHAL_USER_SUB missing or unset for the container); refusing to ship a report with no headline number" }
  Note ("numbers verified: " + $dd.date + "  equity " + $dd.results.equity + "  day P/L " + $dd.results.pl + " (" + $dd.results.pct + "%)")
  python "$REPO\packages\oshal-vids-operator\make-deck-detailed.py" 2>&1 | Out-Null
  if (-not (Test-Path "$OUT\deck.pptx")) { Fail "deck.pptx not built" }
}

# 3) STAGE to node
Note "staging inputs + goal to node…"
NodePush "$OUT\deck-data.json" "$NodeOut\deck-data.json"
NodePush "$OUT\deck.pptx"      "$NodeOut\deck.pptx"
# one-time: the headshot on the node (the node only makes the 4 pieces; the host combines with the sting)
$chk = Join-Path $env:TEMP 'recap-head-chk.ps1'
"'HEAD='+(Test-Path '$NodeOut\presenter-head.png')" | Set-Content $chk -Encoding ascii
if ((NodeShell $chk 20000) -notmatch 'HEAD=True') { NodePush "$OUT\presenter-head.png" "$NodeOut\presenter-head.png" }
$goalRemote = "$parent\RECAP-BUILD-GOAL.md"
NodePush $GOAL $goalRemote

# 4) BUILD — launch, cold-start retry, poll (skippable with -SkipBuild to reuse existing pieces)
if (-not $SkipBuild) {
$launch = Join-Path $env:TEMP 'recap-launch.ps1'
@"
Set-ExecutionPolicy -Scope Process Bypass -Force
`$o='$NodeOut'
Remove-Item "`$o\BUILD.done","`$o\BUILD.err","`$o\build.log" -ErrorAction SilentlyContinue
foreach(`$f in @('presenter-intro.mp4','presenter-overview.mp4','presenter-close.mp4','deck-narrated.mp4')){ Remove-Item "`$o\`$f" -Force -ErrorAction SilentlyContinue }
`$inner = "Set-Location '$parent'; Get-Content '$goalRemote' -Raw | claude --dangerously-skip-permissions -p *> '`$o\build.log'"
`$p = Start-Process powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',`$inner) -WindowStyle Hidden -PassThru
`$p.Id | Out-File "`$o\build.pid" -Encoding ascii
"LAUNCHED=" + `$p.Id
"@ | Set-Content $launch -Encoding ascii
# progress probe: PNGs written in the last 4 min (agent is actually driving Vids)
$probe = Join-Path $env:TEMP 'recap-probe.ps1'
"'PNG='+((Get-ChildItem '$NodeOut' -Filter *.png -ErrorAction SilentlyContinue | Where-Object{`$_.LastWriteTime -gt (Get-Date).AddMinutes(-4)}|Measure-Object).Count)+' DONE='+(Test-Path '$NodeOut\BUILD.done')+' ERR='+(Test-Path '$NodeOut\BUILD.err')" | Set-Content $probe -Encoding ascii

Note "launching node agent…"; NodeShell $launch 40000 | Out-Null
Start-Sleep -Seconds 300
if ((NodeShell $probe 25000) -match 'PNG=0 ') {   # cold-start hang -> relaunch once
  Note "cold-start hang (no output in 5 min) -> relaunching agent once"
  $kill = Join-Path $env:TEMP 'recap-kill.ps1'
  "`$p=Get-Content '$NodeOut\build.pid' -ErrorAction SilentlyContinue; if(`$p){ cmd /c taskkill /PID `$p /T /F 2>`$null }; Get-Process claude -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue" | Set-Content $kill -Encoding ascii
  NodeShell $kill 25000 | Out-Null; Start-Sleep 3
  NodeShell $launch 40000 | Out-Null
}
Note "building (poll ~45 min)…"
$done = $false
for ($i=0; $i -lt 135; $i++) {
  Start-Sleep -Seconds 20
  $s = NodeShell $probe 25000
  if ($s -match 'DONE=True') { $done = $true; Note "BUILD.done"; break }
  if ($s -match 'ERR=True')  { $e = NodeShell (Join-Path $env:TEMP 'recap-err.ps1') 20000; Fail "node build error (see $NodeOut\BUILD.err on $Node)" }
}
if (-not $done) { Fail "node build did not finish (no BUILD.done). Check $NodeOut\build.log on $Node." }
} else { Note "-SkipBuild: reusing the 4 pieces already on the node" }

# 5) COLLECT — pull the 4 pieces and COMBINE them here in the user's local space.
# The check is existence + size + FRESHNESS: a leftover prior-day piece passes an existence check
# and silently assembles yesterday's clip into today's video (nearly shipped 2026-07-28).
Note "pulling 4 pieces from node…"
$pieces = @('presenter-intro.mp4','presenter-overview.mp4','presenter-close.mp4','deck-narrated.mp4')
foreach ($f in $pieces) { NodePull "$NodeOut\$f" "$OUT\$f" }
foreach ($f in $pieces) {
  if (-not (Test-Path "$OUT\$f") -or (Get-Item "$OUT\$f").Length -lt 300KB) { Fail "piece missing/too small: $f (check $NodeOut\build.log on $Node)" }
  if ((Get-Item "$OUT\$f").LastWriteTime -lt $runStart) { Fail "piece STALE: $f predates this run (pull failed silently; a prior day's clip must never ship as today's)" }
}
Note "combining (assemble-recap.js)…"; & node "$REPO\scripts\assemble-recap.js" 2>&1 | Tee-Object -FilePath $log -Append
$vid = "$OUT\trade-recap.mp4"
if (-not (Test-Path $vid) -or (Get-Item $vid).Length -lt 1MB) { Fail "assemble produced no/short trade-recap.mp4" }
Note "rendering PDF…"; $pdf = "$OUT\$Date.pdf"
$pp = New-Object -ComObject PowerPoint.Application
try { $pr = $pp.Presentations.Open("$OUT\deck.pptx", -1, 0, 0); $pr.SaveAs($pdf, 32); $pr.Close() } finally { $pp.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($pp) | Out-Null }

# 6) DELIVER — email the finished video to the user (compressed for the attachment).
# RECAP_EMAIL_TO / OSHAL_USER_SUB come from the operator's host environment (or .env) — the repo
# ships placeholders only. Without OSHAL_USER_SUB the email script cannot find the operator's
# Google connection (it falls back to a placeholder sub and SEND_FAILs).
Note "compressing + emailing to the user…"
& $FF -y -hide_banner -loglevel error -i $vid -vcodec libx264 -crf 30 -preset fast -acodec aac -b:a 96k -movflags +faststart "$OUT\recap-email.mp4" 2>&1 | Out-Null
$RecapTo = if ($env:RECAP_EMAIL_TO) { $env:RECAP_EMAIL_TO } else { 'owner@example.com' }
$SubArgs = @(); if ($env:OSHAL_USER_SUB) { $SubArgs = @('-e', "OSHAL_USER_SUB=$($env:OSHAL_USER_SUB)") }
$mail = docker exec -e "RECAP_EMAIL_TO=$RecapTo" @SubArgs oshal-local-api node /app/scripts/oshal-recap-email.js 2>&1 | Out-String
Note ("email: " + (($mail -split "`n" | Where-Object { $_ -match 'SEND_' } | Select-Object -Last 1)))
if ($mail -notmatch 'SEND_OK') { Fail "email delivery failed: $mail" }

# 7) ARCHIVE (bonus) — keep a dated copy in the finance-history git repo
try { & "$FINREPO\scripts\add-recap-entry.ps1" -Date $Date -Video $vid -Deck "$OUT\deck.pptx" -Pdf $pdf -DeckData "$OUT\deck-data.json" 2>&1 | Tee-Object -FilePath $log -Append } catch { Note "archive skipped: $($_.Exception.Message)" }

# 8) PUBLISH - agenticfederal.us (git push + wrangler deploy + prod verify). The site pages are
# data-driven off media/recaps/index.json, so this is files + one JSON prepend. A publish failure
# must not un-succeed the email/archive above - note it + alert, don't exit hard.
Note "publishing to agenticfederal.us..."
& powershell -NoProfile -ExecutionPolicy Bypass -File "$REPO\scripts\publish-agenticfederal-recap.ps1" -Date $Date 2>&1 | Tee-Object -FilePath $log -Append
if ($LASTEXITCODE -ne 0) {
  Note "PUBLISH FAILED (recap emailed + archived fine; site not updated - run publish-agenticfederal-recap.ps1 -Date $Date manually)"
  try { docker exec oshal-local-api node /app/scripts/oshal-send-alert.js "OSHAL recap $Date - site publish FAILED" ("The recap emailed and archived fine, but the site publish failed - see " + $log + ". Re-run: powershell -File scripts/publish-agenticfederal-recap.ps1 -Date " + $Date) 2>&1 | Out-Null } catch {}
} else { Note "site publish verified live" }
Note "=== DONE: $Date recap emailed to the user (+ archived + published) ==="
