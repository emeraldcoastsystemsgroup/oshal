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
    6. DELIVER: create an immutable delivery manifest, email the verified video, and archive the day.
    7. PUBLISH: publish the same frozen delivery to AgenticFederal and the required ECSG mirror,
                then verify public index provenance and artifact hashes before reporting success.
  The api :35457 event loop hangs periodically; every node call auto-restarts it on ECONNRESET and retries.
  Any hard failure writes a note + an ALERT EMAIL (oshal-send-alert.js) so a miss is never silent —
  a blocking desktop dialog is useless to an unattended nightly (2026-07-28: two weeks of misses hid
  behind exactly that). The runner also writes ops-notes.json (lateness, api restarts, watchdog
  recoveries) which the deck generator folds into the report's "What changed / Operations" section.

  Usage: run-daily-recap.ps1 [-Date YYYY-MM-DD] [-Node <clientId>] [-SkipData] [-SkipBuild] [-ResumePull]
  Verify: run-daily-recap.ps1 -VerifyDeliveryManifest <manifest> [-DeliveryArtifactRoot <dir>]
          exits 0 for valid, 1 for a verified mismatch, and 2 for unreadable input.

  CHANGE LOG  (started 2026-07-30 — this file predates the convention; earlier history is in git)
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Verify node transfers AT the transfer. NodePush/NodePull piped RN's output to Out-Null, and RN returns its last output after exhausting retries - so a transfer that never landed was indistinguishable from one that did. On 2026-07-30 the four piece pulls ran 26 minutes, reported nothing, and handed the assembler a prior day's deck-narrated.mp4; the step-5 freshness gate caught it (correctly) but only after the whole window was spent, and the operator got a failure that named a stale file rather than the dead transfer that caused it. Each helper now checks the driver's failure text and then the file it was supposed to produce - existence, and that the local copy actually changed. The step-5 freshness gate stays: it covers the different case of a remote piece that is itself stale.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the driver's actionable failure line in transfer alerts. PowerShell 5.1 appends a generic NativeCommandError record after native stderr, so reporting only the final line hid the actual HTTP 429 that stopped the 2026-08-03 pull.
  3 | maintainer@emeraldcoastsystemsgroup.com   | Invoke the publisher beside this runner, not the retired recap-assets checkout. The stale checkout's publisher predated the ECSG mirror, so agenticfederal updated while emeraldcoastsystemsgroup remained stale.
  4 | maintainer@emeraldcoastsystemsgroup.com   | Survive a control-plane restart during collection: retry node-not-found/offline/enqueue failures while the desktop re-registers, and add an explicit SHA-256-verified -ResumePull recovery mode so a completed piece is never downloaded twice or trusted by size alone.
  5 | maintainer@emeraldcoastsystemsgroup.com   | Return non-zero when publishing fails. Email/archive remain durable, but claiming DONE and leaving Task Scheduler green while any required site is stale masked the exact failure the operator needed surfaced.
  6 | maintainer@emeraldcoastsystemsgroup.com   | Bind every build and resumed pull to one immutable completed-run manifest, then bind the assembled deck, dated PDF, and final video to a linked immutable delivery manifest. SkipBuild, ResumePull, and the publisher-facing verifier fail closed on missing, partial, stale, or mismatched provenance.
  7 | maintainer@emeraldcoastsystemsgroup.com   | Hand the exact output root and verified delivery-manifest pointer to the publisher. The publisher no longer guesses a mutable default directory or trusts same-named artifacts from another run.
  8 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the former final-video size rail inside the canonical delivery verifier: a hash-consistent but truncated deck, PDF, or sub-1MB video cannot authorize publication.
  9 | maintainer@emeraldcoastsystemsgroup.com   | Validate a real Eastern-market calendar date before constructing paths, identify build manifests by kind, and atomically promote local/remote pointers with Windows-compatible backup paths.
  10 | maintainer@emeraldcoastsystemsgroup.com  | Hash and parse the referenced build manifest from one read-locked byte buffer, closing the verifier's hash-then-reread substitution window.
  11 | maintainer@emeraldcoastsystemsgroup.com  | Return the delivery manifest digest computed from the exact parsed byte snapshot so publishers can bind verifier success to their locked input.
  12 | maintainer@emeraldcoastsystemsgroup.com  | Add an inert synchronization probe at the verified-byte boundary so manifest substitution has deterministic behavioral coverage instead of a timing-sensitive race.
  13 | maintainer@emeraldcoastsystemsgroup.com  | Require object-root manifest JSON, stop before deriving paths from invalid identities, and gate the race probe to an explicit temp-scoped contract operation.
  14 | maintainer@emeraldcoastsystemsgroup.com  | Reconcile inline workflow and recovery documentation with automatic manifest-gated primary and mirror publication.
  15 | maintainer@emeraldcoastsystemsgroup.com  | Hold one host-wide mutex across the complete normal run so nightly and manual invocations cannot mix shared staging, assembly, manifest, or publication files; verifier and manifest-contract modes remain lock-free.
  16 | maintainer@emeraldcoastsystemsgroup.com  | Acquire, heartbeat, and exact-token release the PostgreSQL render-node lease shared with the video pump before touching the node; local mutex and blackout remain defense-in-depth.
  17 | maintainer@emeraldcoastsystemsgroup.com  | Complete the immutable build-manifest contract with explicit date/start/input digests and fail-closed ffprobe evidence for every MP4 before promotion; manifests from the former size-and-hash-only path can no longer authorize SkipBuild or ResumePull.
  18 | maintainer@emeraldcoastsystemsgroup.com  | Let the temp-scoped run-lock test contract declare a validated bounded hold window so concurrent PowerShell probes cannot expire the lock owner under full-suite startup pressure; production mutex behavior is unchanged.
#>
[CmdletBinding()]
param(
  [string]$Date,
  [string]$Node    = 'oshal-chat-0ce849b6-8b95-4cf5-9223-ce22d638f1c9',  # render-node-1 @ localhost
  [string]$NodeOut = 'C:\oshal-vidsop\out',
  [switch]$SkipData,
  [switch]$SkipBuild,  # reuse the pieces already on the node (skip the ~40-min generation)
  [switch]$ResumePull, # reuse only local pieces whose SHA-256 matches the completed build manifest
  [string]$ManifestContractProbe, # test-only JSON probe; exits before any node, Docker, or filesystem workflow
  [string]$VerifyDeliveryManifest, # publisher-facing fail-closed verification mode; prints JSON and exits
  [string]$DeliveryArtifactRoot    # defaults to the delivery manifest's directory
)
# NOT 'Stop': native commands (node/docker) write progress to stderr which, under Stop + 2>&1,
# PowerShell 5.1 turns into a terminating NativeCommandError. We gate real failures with Fail() checks.
$ErrorActionPreference = 'Continue'
function Test-RecapCalendarDate([string]$Value) {
  $parsed = [datetime]::MinValue
  return [datetime]::TryParseExact(
    $Value,
    'yyyy-MM-dd',
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::None,
    [ref]$parsed
  )
}
function Set-RecapManifestPointer([string]$Source, [string]$Destination) {
  $pending = "$Destination.pending-$([guid]::NewGuid().ToString('N'))"
  $backup = "$Destination.backup-$([guid]::NewGuid().ToString('N'))"
  try {
    [IO.File]::Copy($Source, $pending, $false)
    if (Test-Path -LiteralPath $Destination) { [IO.File]::Replace($pending, $Destination, $backup) }
    else { [IO.File]::Move($pending, $Destination) }
  } finally {
    foreach ($temporary in @($pending, $backup)) {
      if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
  }
}
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
if (-not $Date) {
  # Windows' Eastern zone applies EST/EDT correctly; a fixed UTC-5 offset selected
  # the prior market day for one hour every evening during daylight-saving time.
  $Date = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([datetime]::UtcNow, 'Eastern Standard Time').ToString('yyyy-MM-dd')
}
if (-not (Test-RecapCalendarDate $Date)) { throw "bad date '$Date' (want a real YYYY-MM-DD calendar date)" }
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
function RestartApi(){
  Note 'api hung -> restarting oshal-local-api'
  docker restart oshal-local-api | Out-Null
  if ($LASTEXITCODE -ne 0) { Note "api restart command failed with exit $LASTEXITCODE"; return $false }
  $lastError = ''
  for($i=0;$i -lt 30;$i++){
    try {
      if((Invoke-WebRequest 'http://127.0.0.1:35457/api/health' -TimeoutSec 5 -UseBasicParsing).StatusCode -eq 200){
        Start-Sleep 28
        return $true
      }
    } catch { $lastError = $_.Exception.Message }
    Start-Sleep 4
  }
  Note "api remained unhealthy after restart: $lastError"
  return $false
}
# Run a codex-remote-node subcommand from the repo cwd (so .env is found). Simple retry on a
# transient reset — a short wait, NOT an api restart (restarting knocks the node out of the
# in-memory registry and loops). If the api is genuinely down, the caller's health guard restarts it.
function RN([string[]]$rnArgs){
  for($try=0;$try -lt 8;$try++){
    $out = & node $RNJS @rnArgs 2>&1 | Out-String
    if ($out -notmatch 'ECONNRESET|fetch failed|timed out|rate limit|Remote client.*(?:not found|offline|not registered)|enqueue .* failed HTTP (?:404|409|429|502|503)') { return $out }
    Note ("node call transient (retry " + ($try + 1) + "/8): " + (TransferError $out))
    Start-Sleep -Seconds 15
  }
  return $out
}
function NodeShell($psFile,[int]$t=45000){ RN @('shell', "--client=$Node", "--timeoutMs=$t", "--cmdFile=$psFile") }

# The recap and controller video pump coordinate through ONE PostgreSQL row. The CLI runs inside the
# controller container so it uses the normal least-privilege app role; it stamps an explicit system
# transaction and exposes only acquire/renew/release, never arbitrary SQL or a database credential.
function Invoke-NodeLeaseCli([string[]]$LeaseArgs) {
  $text = & docker exec oshal-local-api node /app/scripts/oshal-node-lease.js @LeaseArgs 2>&1 | Out-String
  $status = $LASTEXITCODE
  $record = $null
  foreach ($line in @($text -split "`n" | Where-Object { $_.Trim().StartsWith('{') })) {
    try { $record = $line.Trim() | ConvertFrom-Json -ErrorAction Stop } catch { }
  }
  return [pscustomobject]@{ status = $status; record = $record; text = $text.Trim() }
}
function Enter-SharedNodeLease {
  $minutes = if ($env:OSHAL_RECAP_NODE_LEASE_MINUTES) { [int]$env:OSHAL_RECAP_NODE_LEASE_MINUTES } else { 360 }
  if ($minutes -lt 1 -or $minutes -gt 720) { throw 'OSHAL_RECAP_NODE_LEASE_MINUTES must be between 1 and 720' }
  $resource = "vids-render-node:$Node"
  $holder = "daily-recap:${Date}:$([guid]::NewGuid().ToString('N'))"
  $metadata = @{ requestedDate = $Date; nodeClientId = $Node } | ConvertTo-Json -Compress
  $call = Invoke-NodeLeaseCli @(
    'acquire', '--resource', $resource, '--holder', $holder, '--purpose', 'daily-recap-build-publish',
    '--ttl-seconds', [string]($minutes * 60), '--metadata-json', $metadata
  )
  if ($null -eq $call.record) { throw "node-lease CLI returned no JSON (exit $($call.status)): $($call.text)" }
  if ($call.record.message) { throw "node-lease CLI failed (exit $($call.status)): $($call.record.message)" }
  if ($call.status -ne 0 -or -not [bool]$call.record.acquired) {
    $who = if ($call.record.holder) { [string]$call.record.holder } else { 'another workflow' }
    $until = if ($call.record.expires_at) { [string]$call.record.expires_at } else { 'an unknown expiry' }
    throw "render node is already leased by $who until $until"
  }
  return [pscustomobject]@{
    resourceKey = $resource; holder = $holder; leaseId = [string]$call.record.lease_id
    ttlSeconds = ($minutes * 60); expiresAt = [string]$call.record.expires_at
  }
}
function Renew-SharedNodeLease($Lease) {
  if ($null -eq $Lease) { throw 'cannot renew a missing shared node lease' }
  $call = Invoke-NodeLeaseCli @(
    'renew', '--resource', $Lease.resourceKey, '--holder', $Lease.holder,
    '--lease-id', $Lease.leaseId, '--ttl-seconds', [string]$Lease.ttlSeconds
  )
  if ($call.status -ne 0 -or $null -eq $call.record -or -not [bool]$call.record.renewed) {
    throw "lost the durable render-node lease; refusing further node work: $($call.text)"
  }
  $Lease.expiresAt = [string]$call.record.expires_at
  return $Lease
}
function Exit-SharedNodeLease($Lease) {
  if ($null -eq $Lease) { return }
  $call = Invoke-NodeLeaseCli @(
    'release', '--resource', $Lease.resourceKey, '--holder', $Lease.holder, '--lease-id', $Lease.leaseId
  )
  if ($call.status -ne 0 -or $null -eq $call.record -or -not [bool]$call.record.released) {
    Note "shared node lease was not released by this invocation (it may have expired/replaced): $($call.text)"
  } else { Note "shared render-node lease released" }
}
# A transfer that never landed used to be INVISIBLE. RN returns its last output after exhausting
# its retries, and both helpers piped that straight to Out-Null — so a dead transfer and a good
# one were the same thing to every caller. On 2026-07-30 four piece pulls "succeeded" over 26
# minutes and handed the assembler a PRIOR DAY's deck-narrated.mp4; only the freshness gate at
# step 5 noticed, 26 minutes late. Verify AT the transfer instead: the driver's own failure text,
# then the file the transfer was supposed to produce.
function TransferError($s){
  $lines = @($s -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $actionable = @($lines | Where-Object { $_ -notmatch 'CategoryInfo|FullyQualifiedErrorId' -and $_ -match 'FAIL:|HTTP 429|rate limit|ECONNRESET|fetch failed|timed out|ENOENT|no such file' } | Select-Object -Last 1)
  if ($actionable.Count) { return $actionable[0] }
  $useful = @($lines | Where-Object { $_ -notmatch '^(At |\+ |CategoryInfo|FullyQualifiedErrorId)' } | Select-Object -Last 1)
  if ($useful.Count) { return $useful[0] }
  return '(no output)'
}
# 'FAIL:' is how the driver reports its own hard errors (die()) — including a truncated chunk,
# which must never be spliced into a file. Matching it here means a driver-side abort is caught
# by the same path as a transport error rather than falling through as an apparent success.
function TransferFailed($out){ return ($out -match 'ECONNRESET|fetch failed|timed out|ENOENT|no such file|FAIL:') }
function NodePush($local,$remote){
  $out = RN @('push', "--client=$Node", "--local=$local", "--remote=$remote")
  if (TransferFailed $out) { Fail ("push FAILED for " + (Split-Path $local -Leaf) + " -> " + $Node + ": " + (TransferError $out)) }
}
# Pulls are CHUNKED and take minutes for a video piece; the driver's default 30s result window
# guarantees a "timed out" no matter how healthy the node is (root-caused 2026-07-28 — every
# nightly piece pull was structurally doomed). Wait long enough for the transfer to finish.
function NodePull($remote,$local){ $name = Split-Path $remote -Leaf
  $before = if (Test-Path $local) { (Get-Item $local).LastWriteTime } else { [datetime]::MinValue }
  $out = RN @('pull', "--client=$Node", "--timeoutMs=600000", "--remote=$remote", "--local=$local")
  if (TransferFailed $out) { Fail ("pull FAILED for $name from $Node - " + (TransferError $out) + " (a locked or blank desktop session on the node looks exactly like this)") }
  if (-not (Test-Path $local)) { Fail "pull of $name reported no error but produced no local file" }
  if ((Get-Item $local).LastWriteTime -le $before) { Fail "pull of $name did not refresh the local copy - the transfer silently no-opped, leaving the prior day's file on disk" }
}

function Get-ArtifactRecord($name,$path){
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "artifact missing: $name ($path)" }
  $item = Get-Item -LiteralPath $path
  [pscustomobject]@{ name = $name; bytes = [long]$item.Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
}
function Get-InputManifestErrors($actual,$expected,[string]$label='input'){
  $errors = @(); $actualItems = @($actual); $expectedItems = @($expected)
  if ($actualItems.Count -ne $expectedItems.Count) { $errors += "$label count is $($actualItems.Count), expected $($expectedItems.Count)" }
  foreach ($want in $expectedItems) {
    $found = @($actualItems | Where-Object { [string]$_.name -ceq [string]$want.name })
    if ($found.Count -ne 1) { $errors += "$label '$($want.name)' must appear exactly once"; continue }
    $got = $found[0]
    if ([string]$got.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or [string]$got.sha256 -ine [string]$want.sha256) { $errors += "$label '$($want.name)' SHA-256 mismatch" }
    if ([long]$got.bytes -ne [long]$want.bytes) { $errors += "$label '$($want.name)' byte length mismatch" }
  }
  return @($errors)
}
function Get-PieceManifestErrors($actual,[string[]]$requiredNames){
  $errors = @(); $actualItems = @($actual)
  if ($actualItems.Count -ne $requiredNames.Count) { $errors += "piece count is $($actualItems.Count), expected $($requiredNames.Count)" }
  foreach ($name in $requiredNames) {
    $found = @($actualItems | Where-Object { [string]$_.name -ceq $name })
    if ($found.Count -ne 1) { $errors += "piece '$name' must appear exactly once"; continue }
    if ([string]$found[0].sha256 -notmatch '^[A-Fa-f0-9]{64}$') { $errors += "piece '$name' has no valid SHA-256" }
    if ([long]$found[0].bytes -lt 300KB) { $errors += "piece '$name' is partial ($($found[0].bytes) bytes)" }
    if ($found[0].mediaVerified -isnot [bool] -or -not [bool]$found[0].mediaVerified) { $errors += "piece '$name' has no successful media verification" }
  }
  return @($errors)
}
function Get-RecapManifestErrors($manifest,[string]$expectedDate,$expectedInputs,[string[]]$requiredPieces){
  $errors = @()
  if ($null -eq $manifest) { return @('manifest is missing') }
  if ([int]$manifest.schemaVersion -ne 1 -or [string]$manifest.manifestKind -cne 'recap-build') { $errors += 'build manifest schema is invalid' }
  if ([string]$manifest.runId -notmatch '^[A-Fa-f0-9]{32}$') { $errors += 'runId must be a 32-character GUID' }
  if ([string]$manifest.date -cne $expectedDate) { $errors += "date '$($manifest.date)' does not match '$expectedDate'" }
  if ([string]$manifest.requestedDate -cne $expectedDate) { $errors += "requestedDate '$($manifest.requestedDate)' does not match '$expectedDate'" }
  if ([string]$manifest.status -cne 'complete') { $errors += "status '$($manifest.status)' is not complete" }
  $startedAt = [datetimeoffset]::MinValue
  $startedAtValid = [datetimeoffset]::TryParse([string]$manifest.startedAt, [ref]$startedAt)
  if (-not $startedAtValid) { $errors += 'startedAt is missing or invalid' }
  $completedAt = [datetimeoffset]::MinValue
  $completedAtValid = [datetimeoffset]::TryParse([string]$manifest.completedAt, [ref]$completedAt)
  if (-not $completedAtValid) { $errors += 'completedAt is missing or invalid' }
  if ($startedAtValid -and $completedAtValid -and $completedAt -lt $startedAt) { $errors += 'completedAt precedes startedAt' }
  $errors += @(Get-InputManifestErrors $manifest.inputs $expectedInputs)
  $deckData = @($manifest.inputs | Where-Object { [string]$_.name -ceq 'deck-data.json' })
  if ([string]$manifest.deckDataSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or $deckData.Count -ne 1 -or [string]$manifest.deckDataSha256 -ine [string]$deckData[0].sha256) {
    $errors += 'deckDataSha256 does not match the deck-data.json input'
  }
  $deckPptx = @($manifest.inputs | Where-Object { [string]$_.name -ceq 'deck.pptx' })
  if ([string]$manifest.deckPptxSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or $deckPptx.Count -ne 1 -or [string]$manifest.deckPptxSha256 -ine [string]$deckPptx[0].sha256) {
    $errors += 'deckPptxSha256 does not match the deck.pptx input'
  }
  $errors += @(Get-PieceManifestErrors $manifest.pieces $requiredPieces)
  return @($errors | Where-Object { $_ })
}
function Test-PieceMatchesArtifact($path,$artifact){
  if ($null -eq $artifact -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $path
  if ([long]$item.Length -ne [long]$artifact.bytes) { return $false }
  return ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ieq [string]$artifact.sha256)
}
function Wait-VerifiedJsonSnapshotProbe([string]$path){
  $ready = $env:OSHAL_RECAP_TEST_VERIFIED_JSON_READY
  if (-not $ready) { return }
  if (-not $ManifestContractProbe -or -not (Test-Path -LiteralPath $ManifestContractProbe -PathType Leaf)) { return }
  try { $contract = Get-Content -LiteralPath $ManifestContractProbe -Raw | ConvertFrom-Json -ErrorAction Stop }
  catch { return }
  if ([string]$contract.operation -cne 'verifiedJsonSnapshotRace') { return }
  $target = $env:OSHAL_RECAP_TEST_VERIFIED_JSON_TARGET
  $release = $env:OSHAL_RECAP_TEST_VERIFIED_JSON_RELEASE
  if (-not $target -or -not $release) { throw 'verified-JSON test probe requires target and release paths' }
  $tempRoot = [IO.Path]::GetFullPath([string]$env:TEMP).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  foreach ($probePath in @($ready, $release, $target, $path)) {
    if (-not [IO.Path]::GetFullPath($probePath).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'verified-JSON test probe paths must remain under the temporary directory'
    }
  }
  if ([IO.Path]::GetFullPath($target) -ine [IO.Path]::GetFullPath($path)) { return }
  [IO.File]::WriteAllText($ready, $path, (New-Object Text.UTF8Encoding($false)))
  $deadline = [datetime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $release -PathType Leaf)) {
    if ([datetime]::UtcNow -ge $deadline) { throw 'verified-JSON test probe timed out' }
    Start-Sleep -Milliseconds 10
  }
}
function Read-JsonFileSnapshot($path,[string]$label){
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$label is missing" }
  $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -gt 10MB) { throw "$label exceeds the 10 MB safety limit" }
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -le 0) { throw "$label ended before its declared length" }
      $offset += $count
    }
  } finally { $stream.Dispose() }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  # This remains inert outside tests. At this boundary the path may change, but parsing must keep
  # using the exact byte buffer whose digest was just computed rather than opening the path again.
  Wait-VerifiedJsonSnapshotProbe $path
  try {
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    $raw = $encoding.GetString($bytes)
    if (-not $raw.TrimStart().StartsWith('{')) { throw "$label root must be an object" }
    $value = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch { throw "$label is unreadable: $($_.Exception.Message)" }
  if ($null -eq $value -or $value -isnot [pscustomobject]) { throw "$label root must be an object" }
  return [pscustomobject]@{ Value = $value; Bytes = [long]$bytes.Length; Sha256 = $hash }
}
function Read-VerifiedJsonArtifact($path,$artifact,[string]$label){
  if ($null -eq $artifact) { throw "$label provenance is missing" }
  $snapshot = Read-JsonFileSnapshot $path $label
  if ([long]$snapshot.Bytes -ne [long]$artifact.bytes) { throw "$label byte length mismatch" }
  if ([string]$snapshot.Sha256 -ine [string]$artifact.sha256) { throw "$label SHA-256 mismatch" }
  return $snapshot.Value
}
function Write-ImmutableJsonFile($value,$path){
  $json = $value | ConvertTo-Json -Depth 8 -Compress
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
function Get-DeliveryManifestErrors($delivery,$artifactRoot){
  $errors = @(); $pieceNames = @('presenter-intro.mp4','presenter-overview.mp4','presenter-close.mp4','deck-narrated.mp4')
  $inputNames = @('deck-data.json','deck.pptx','presenter-head.png','RECAP-BUILD-GOAL.md')
  if ($null -eq $delivery) { return @('delivery manifest is missing') }
  if ([int]$delivery.schemaVersion -ne 1 -or [string]$delivery.manifestKind -cne 'recap-delivery') { $errors += 'delivery manifest schema is invalid' }
  if ([string]$delivery.runId -notmatch '^[A-Fa-f0-9]{32}$') { $errors += 'delivery runId is invalid' }
  if ([string]$delivery.deliveryId -notmatch '^[A-Fa-f0-9]{32}$') { $errors += 'deliveryId is invalid' }
  if (-not (Test-RecapCalendarDate ([string]$delivery.requestedDate))) { $errors += 'delivery requestedDate is invalid' }
  # Do not interpolate invalid date/run identifiers into Join-Path. A rejected
  # manifest must not be able to probe files outside the declared artifact root.
  if ($errors.Count) { return @($errors) }
  if ([string]$delivery.status -cne 'complete') { $errors += "delivery status '$($delivery.status)' is not complete" }
  foreach ($name in $inputNames) {
    if (@($delivery.inputs | Where-Object { [string]$_.name -ceq $name }).Count -ne 1) {
      $errors += "delivery input '$name' must appear exactly once"
    }
  }
  if (@($delivery.inputs).Count -ne $inputNames.Count) { $errors += "delivery input count must be $($inputNames.Count)" }
  $completedAt = [datetimeoffset]::MinValue
  if (-not [datetimeoffset]::TryParse([string]$delivery.completedAt, [ref]$completedAt)) { $errors += 'delivery completedAt is missing or invalid' }
  $outputNames = @('deck.pptx', "$($delivery.requestedDate).pdf", 'trade-recap.mp4'); $actualOutputs = @()
  foreach ($name in $outputNames) {
    try { $actualOutputs += Get-ArtifactRecord $name (Join-Path $artifactRoot $name) }
    catch { $errors += $_.Exception.Message }
  }
  $minimumBytes = @{ 'deck.pptx' = 10KB; "$($delivery.requestedDate).pdf" = 10KB; 'trade-recap.mp4' = 1MB }
  foreach ($actual in $actualOutputs) {
    if ([long]$actual.bytes -lt [long]$minimumBytes[[string]$actual.name]) {
      $errors += "output '$($actual.name)' is partial ($($actual.bytes) bytes)"
    }
  }
  $errors += @(Get-InputManifestErrors $delivery.outputs $actualOutputs 'output')
  $buildName = "build-artifacts-$($delivery.runId).json"; $buildPath = Join-Path $artifactRoot $buildName; $build = $null
  if ([string]$delivery.buildManifest.name -cne $buildName) { $errors += 'referenced build manifest identity is invalid' }
  else { try { $build = Read-VerifiedJsonArtifact $buildPath $delivery.buildManifest 'referenced build manifest' } catch { $errors += $_.Exception.Message } }
  if ($null -ne $build) {
    $errors += @(Get-RecapManifestErrors $build ([string]$delivery.requestedDate) $delivery.inputs $pieceNames)
    $errors += @(Get-InputManifestErrors $delivery.inputs $build.inputs)
    $errors += @(Get-InputManifestErrors $delivery.pieces $build.pieces 'piece')
    $deliveryDeck = @($delivery.outputs | Where-Object { $_.name -ceq 'deck.pptx' })
    $buildDeck = @($build.inputs | Where-Object { $_.name -ceq 'deck.pptx' })
    $errors += @(Get-InputManifestErrors $deliveryDeck $buildDeck 'delivery deck')
    if ([string]$build.runId -cne [string]$delivery.runId) { $errors += 'delivery runId does not match the build manifest' }
  }
  return @($errors | Where-Object { $_ })
}
function Invoke-ManifestContractProbe($path){
  $probe = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if ([string]$probe.operation -eq 'validate') {
    $errors = @(Get-RecapManifestErrors $probe.manifest ([string]$probe.date) $probe.inputs ([string[]]$probe.requiredPieces))
    return [pscustomobject]@{ valid = ($errors.Count -eq 0); errors = $errors }
  }
  if ([string]$probe.operation -eq 'pieceMatches') {
    return [pscustomobject]@{ matches = [bool](Test-PieceMatchesArtifact ([string]$probe.path) $probe.artifact) }
  }
  if ([string]$probe.operation -eq 'writeImmutable') {
    Write-ImmutableJsonFile $probe.value ([string]$probe.path)
    return [pscustomobject]@{ written = $true }
  }
  throw "unknown manifest probe operation '$($probe.operation)'"
}

function Get-RecapRunLockTestContract {
  $path = $env:OSHAL_RECAP_TEST_RUN_LOCK_CONTRACT
  if (-not $path) { return $null }
  $tempRoot = [IO.Path]::GetFullPath([string]$env:TEMP).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $contract = (Read-JsonFileSnapshot $path 'run-lock test contract').Value
  if ([string]$contract.operation -cne 'holdNormalRunLock') { throw 'run-lock test contract operation is invalid' }
  if ([string]$contract.token -notmatch '^[A-Fa-f0-9]{32}$') { throw 'run-lock test token is invalid' }
  $holdTimeoutMs = 15000
  if ($null -ne $contract.holdTimeoutMs) {
    try { $holdTimeoutMs = [int]$contract.holdTimeoutMs }
    catch { throw 'run-lock test holdTimeoutMs is invalid' }
  }
  if ($holdTimeoutMs -lt 1000 -or $holdTimeoutMs -gt 120000) {
    throw 'run-lock test holdTimeoutMs must be between 1000 and 120000'
  }
  $contract | Add-Member -NotePropertyName validatedHoldTimeoutMs -NotePropertyValue $holdTimeoutMs -Force
  foreach ($candidate in @($path, [string]$contract.ready, [string]$contract.release)) {
    if (-not $candidate -or -not [IO.Path]::GetFullPath($candidate).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'run-lock test paths must remain under the temporary directory'
    }
  }
  return $contract
}

function Enter-RecapRunLock([string]$TestToken = '') {
  # The fixed production name coordinates Task Scheduler and interactive sessions. A validated,
  # temp-scoped token only isolates the behavioral test from a real recap already running on host.
  $suffix = if ($TestToken) { ".test.$TestToken" } else { '' }
  $mutex = [Threading.Mutex]::new($false, "Global\OSHAL.DailyTradeRecap.SharedArtifacts.v1$suffix")
  $ownsMutex = $false
  try { $ownsMutex = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  catch { $mutex.Dispose(); throw }
  if (-not $ownsMutex) {
    $mutex.Dispose()
    throw 'another daily recap run already owns the shared staging and assembly files'
  }
  return $mutex
}

function Exit-RecapRunLock($Mutex) {
  if ($null -eq $Mutex) { return }
  try { $Mutex.ReleaseMutex() }
  finally { $Mutex.Dispose() }
}

function Invoke-RecapRunLockTestContract($Contract) {
  $encoding = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText([string]$Contract.ready, 'entered', $encoding)
  $deadline = [datetime]::UtcNow.AddMilliseconds([int]$Contract.validatedHoldTimeoutMs)
  while (-not (Test-Path -LiteralPath ([string]$Contract.release) -PathType Leaf)) {
    if ([datetime]::UtcNow -ge $deadline) { throw 'run-lock test contract timed out' }
    Start-Sleep -Milliseconds 10
  }
}

if ($VerifyDeliveryManifest) {
  try {
    $resolvedDeliveryManifest = (Resolve-Path -LiteralPath $VerifyDeliveryManifest).Path
    $deliverySnapshot = Read-JsonFileSnapshot $resolvedDeliveryManifest 'delivery manifest'
    $delivery = $deliverySnapshot.Value
    $deliveryRoot = if ($DeliveryArtifactRoot) { $DeliveryArtifactRoot } else { Split-Path -Parent $resolvedDeliveryManifest }
    $deliveryErrors = @(Get-DeliveryManifestErrors $delivery $deliveryRoot)
    [pscustomobject]@{
      valid = ($deliveryErrors.Count -eq 0); errors = $deliveryErrors; runId = $delivery.runId
      manifestSha256 = $deliverySnapshot.Sha256
    } | ConvertTo-Json -Depth 8 -Compress
    if ($deliveryErrors.Count) { exit 1 } else { exit 0 }
  } catch { [pscustomobject]@{ valid = $false; errors = @($_.Exception.Message) } | ConvertTo-Json -Compress; exit 2 }
}
if ($ManifestContractProbe) {
  try { Invoke-ManifestContractProbe $ManifestContractProbe | ConvertTo-Json -Depth 8 -Compress; exit 0 }
  catch { [pscustomobject]@{ error = $_.Exception.Message } | ConvertTo-Json -Compress; exit 2 }
}

$runLockTestContract = Get-RecapRunLockTestContract
$recapRunLock = $null
$sharedNodeLease = $null
try {
  $testToken = if ($null -ne $runLockTestContract) { [string]$runLockTestContract.token } else { '' }
  $recapRunLock = Enter-RecapRunLock $testToken
  if ($null -ne $runLockTestContract) { Invoke-RecapRunLockTestContract $runLockTestContract; exit 0 }

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
$apiProbeError = ''
for ($h = 0; $h -lt 6; $h++) {
  try { if ((Invoke-WebRequest 'http://127.0.0.1:35457/api/health' -TimeoutSec 15 -UseBasicParsing).StatusCode -eq 200) { $apiOk = $true; break } }
  catch { $apiProbeError = $_.Exception.Message }
  Start-Sleep -Seconds 10
}
if (-not $apiOk) {
  Note "api health probe failed after 6 attempts: $apiProbeError"
  if (-not (RestartApi)) { Fail 'api remained unhealthy after the guarded restart' }
}
Note "=== daily recap $Date on node $Node ($NodeOut) ==="
try {
  $sharedNodeLease = Enter-SharedNodeLease
  Note "shared render-node lease acquired through $($sharedNodeLease.expiresAt)"
} catch { Fail "could not acquire the shared render-node lease: $($_.Exception.Message)" }

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
$stray | ForEach-Object {
  $processId = $_.ProcessId
  try { Stop-Process -Id $processId -Force -ErrorAction Stop }
  catch { 'CHROME_PRUNE_FAILED=' + $processId + ':' + $_.Exception.Message }
}
'CHROME_PRUNED='+$stray.Count
$opened = $false; $openErrors = @()
foreach ($m in @('PUT','GET')) {
  try {
    Invoke-WebRequest -Method $m 'http://localhost:9222/json/new?https://docs.google.com/videos/u/0/' -TimeoutSec 8 -UseBasicParsing | Out-Null
    $opened = $true
    break
  } catch { $openErrors += ($m + ':' + $_.Exception.Message) }
}
if (-not $opened) { 'CHROME_TAB_OPEN_FAILED=' + ($openErrors -join '; ') }
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
if ($pfOut -match 'CHROME_PRUNE_FAILED=([^\r\n]+)') { Note ("preflight warning: " + $Matches[1]) }
if ($pfOut -match 'CHROME_TAB_OPEN_FAILED=([^\r\n]+)') { Note ("preflight warning: " + $Matches[1]) }
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
  try { $st = [datetime](docker inspect oshal-local-api --format '{{.State.StartedAt}}' 2>$null); if ($st -gt (Get-Date).AddHours(-24)) { $opsNotes += ("api container restarted at " + $st.ToLocalTime().ToString('HH:mm') + " local (uptime under 24h)") } }
  catch { Note "ops-note API uptime probe failed: $($_.Exception.Message)" }
  try {
    $wdLog = Join-Path $env:LOCALAPPDATA 'oshal\oshal-stack-watchdog.log'
    if (Test-Path $wdLog) {
      $today = (Get-Date).ToString('yyyy-MM-dd'); $yday = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
      $recov = @(Select-String -Path $wdLog -Pattern 'RECOVERY SUCCEEDED' | Where-Object { $_.Line -match [regex]::Escape($today) -or $_.Line -match [regex]::Escape($yday) })
      if ($recov.Count -gt 0) { $opsNotes += ("stack watchdog ran " + $recov.Count + " recovery cycle(s) in the last two days") }
    }
  } catch { Note "ops-note watchdog history probe failed: $($_.Exception.Message)" }
  try {
    $prevLog = Get-ChildItem $FINREPO -Filter 'run-*.log' | Where-Object { $_.Name -ne (Split-Path $log -Leaf) } | Sort-Object Name -Descending | Select-Object -First 1
    if ($prevLog -and (Select-String -Path $prevLog.FullName -Pattern 'FAILED:' -Quiet)) { $opsNotes += ("previous report run (" + $prevLog.BaseName.Replace('run-','') + ") logged a failure - see its log") }
  } catch { Note "ops-note prior-run probe failed: $($_.Exception.Message)" }
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
  python "$REPO\packages\oshal-vids-operator\make-deck-detailed.py" 2>&1 | Out-Null
  if (-not (Test-Path "$OUT\deck.pptx")) { Fail "deck.pptx not built" }
}

# ASSERT THE ARTIFACT even under -SkipData. Otherwise a caller can label yesterday's deck-data
# with today's requested date and create a perfectly hash-consistent but semantically false manifest.
try { $dd = Get-Content "$OUT\deck-data.json" -Raw | ConvertFrom-Json }
catch { Fail "deck-data.json is missing or unreadable: $($_.Exception.Message)" }
$wantLabel = ([datetime]$Date).ToString('MMMM d, yyyy')
if ($dd.date -ne $wantLabel) { Fail "deck-data.json is for '$($dd.date)' but this report is $wantLabel - refusing to build or reuse a mislabeled report" }
if ($null -eq $dd.results.pl) { Fail "deck-data.json has a NULL day P/L (equity store returned nothing - OSHAL_USER_SUB missing or unset); refusing to ship a report with no headline number" }
Note ("numbers verified: " + $dd.date + "  equity " + $dd.results.equity + "  day P/L " + $dd.results.pl + " (" + $dd.results.pct + "%)")

# 3) STAGE to node. Every material build input is hashed before transfer; the completed manifest
# records the node's hashes and validation requires them to match these exact local bytes.
Note "staging inputs + goal to node…"
$goalRemote = "$parent\RECAP-BUILD-GOAL.md"
$pieces = @('presenter-intro.mp4','presenter-overview.mp4','presenter-close.mp4','deck-narrated.mp4')
$inputSpecs = @(
  [pscustomobject]@{ name = 'deck-data.json'; local = "$OUT\deck-data.json"; remote = "$NodeOut\deck-data.json" },
  [pscustomobject]@{ name = 'deck.pptx'; local = "$OUT\deck.pptx"; remote = "$NodeOut\deck.pptx" },
  [pscustomobject]@{ name = 'presenter-head.png'; local = "$OUT\presenter-head.png"; remote = "$NodeOut\presenter-head.png" },
  [pscustomobject]@{ name = 'RECAP-BUILD-GOAL.md'; local = $GOAL; remote = $goalRemote }
)
try { $inputRecords = @($inputSpecs | ForEach-Object { Get-ArtifactRecord $_.name $_.local }) }
catch { Fail $_.Exception.Message }
foreach ($spec in $inputSpecs) { NodePush $spec.local $spec.remote }
try { $sharedNodeLease = Renew-SharedNodeLease $sharedNodeLease }
catch { Fail "shared render-node lease heartbeat failed after staging: $($_.Exception.Message)" }

# 4) BUILD — launch, cold-start retry, poll (skippable with -SkipBuild to reuse existing pieces)
$runId = if (-not $SkipBuild) { [guid]::NewGuid().ToString('N') } else { $null }
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
  if (($i % 15) -eq 0) {
    try { $sharedNodeLease = Renew-SharedNodeLease $sharedNodeLease }
    catch { Fail "shared render-node lease heartbeat failed during build: $($_.Exception.Message)" }
  }
  Start-Sleep -Seconds 20
  $s = NodeShell $probe 25000
  if ($s -match 'DONE=True') { $done = $true; Note "BUILD.done"; break }
  if ($s -match 'ERR=True')  { $e = NodeShell (Join-Path $env:TEMP 'recap-err.ps1') 20000; Fail "node build error (see $NodeOut\BUILD.err on $Node)" }
}
if (-not $done) { Fail "node build did not finish (no BUILD.done). Check $NodeOut\build.log on $Node." }
} else { Note "-SkipBuild: reusing the 4 pieces already on the node" }

# A completed build is represented by an immutable, run-id-named manifest plus a replaceable
# BUILD.manifest.json pointer. The immutable file is created once; the pointer changes only after
# all remote inputs and pieces have been hashed and the complete manifest has passed validation.
$manifestPointerLocal = Join-Path $OUT 'BUILD.manifest.json'
$manifest = $null
if (-not $SkipBuild) {
  $remoteSpecs = @($inputSpecs | ForEach-Object { [pscustomobject]@{ name = $_.name; remote = $_.remote; media = $false } })
  foreach ($pieceName in $pieces) { $remoteSpecs += [pscustomobject]@{ name = $pieceName; remote = "$NodeOut\$pieceName"; media = $true } }
  $remoteSpecLines = @($remoteSpecs | ForEach-Object {
    $safeName = ([string]$_.name).Replace("'", "''"); $safePath = ([string]$_.remote).Replace("'", "''"); $media = if ($_.media) { '$true' } else { '$false' }
    "    [pscustomobject]@{ name = '$safeName'; path = '$safePath'; media = $media }"
  }) -join ",`r`n"
  $artifactProbe = Join-Path $env:TEMP "recap-artifacts-$runId.ps1"
  @"
`$ErrorActionPreference = 'Stop'
try {
  `$specs = @(
$remoteSpecLines
  )
  `$mediaSpecs = @(`$specs | Where-Object { `$_.media })
  `$ffprobePath = `$null
  if (`$mediaSpecs.Count) {
    `$ffprobeName = if (`$env:OSHAL_FFPROBE) { `$env:OSHAL_FFPROBE } else { 'ffprobe' }
    `$ffprobeCommand = Get-Command `$ffprobeName -ErrorAction Stop
    `$ffprobePath = `$ffprobeCommand.Source
  }
  `$records = foreach (`$spec in `$specs) {
    if (-not (Test-Path -LiteralPath `$spec.path -PathType Leaf)) { throw "artifact missing: `$(`$spec.name)" }
    `$item = Get-Item -LiteralPath `$spec.path
    `$record = [ordered]@{ name = `$spec.name; bytes = [long]`$item.Length; sha256 = (Get-FileHash -LiteralPath `$spec.path -Algorithm SHA256).Hash.ToLowerInvariant() }
    if (`$spec.media) {
      `$probeOutput = & `$ffprobePath -v error -select_streams 'v:0' -show_entries 'stream=codec_type:format=duration' -of json `$spec.path 2>&1
      if (`$LASTEXITCODE -ne 0) { throw "media verification failed for `$(`$spec.name): `$(`$probeOutput -join ' ')" }
      try { `$media = (`$probeOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop }
      catch { throw "media verification returned invalid JSON for `$(`$spec.name): `$(`$_.Exception.Message)" }
      `$duration = 0.0
      `$durationValid = [double]::TryParse([string]`$media.format.duration, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]`$duration)
      if (@(`$media.streams | Where-Object { `$_.codec_type -ceq 'video' }).Count -lt 1 -or -not `$durationValid -or `$duration -le 0) {
        throw "media verification found no playable video stream for `$(`$spec.name)"
      }
      `$record.mediaVerified = `$true
    }
    [pscustomobject]`$record
  }
  `$json = `$records | ConvertTo-Json -Depth 4 -Compress
  'ARTIFACTS_JSON_B64=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(`$json))
} catch { 'ARTIFACTS_FAILED=' + `$_.Exception.Message; exit 1 }
"@ | Set-Content $artifactProbe -Encoding ascii
  $artifactOut = NodeShell $artifactProbe 120000
  if ($artifactOut -notmatch 'ARTIFACTS_JSON_B64=([A-Za-z0-9+/=]+)') { Fail "could not inventory completed build artifacts on $Node - $(TransferError $artifactOut)" }
  try { $remoteArtifacts = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1])) | ConvertFrom-Json) }
  catch { Fail "node returned an unreadable build artifact inventory: $($_.Exception.Message)" }
  $remoteInputs = @($inputRecords | ForEach-Object { $name = $_.name; $remoteArtifacts | Where-Object { $_.name -ceq $name } | Select-Object -First 1 })
  $remotePieces = @($pieces | ForEach-Object { $name = $_; $remoteArtifacts | Where-Object { $_.name -ceq $name } | Select-Object -First 1 })
  $inventoryErrors = @()
  $inventoryErrors += @(Get-InputManifestErrors $remoteInputs $inputRecords)
  $inventoryErrors += @(Get-PieceManifestErrors $remotePieces $pieces)
  if ($inventoryErrors.Count) { Fail ("completed build inventory is invalid: " + ($inventoryErrors -join '; ')) }
  $deckDataInput = @($remoteInputs | Where-Object { $_.name -ceq 'deck-data.json' })[0]
  $deckPptxInput = @($remoteInputs | Where-Object { $_.name -ceq 'deck.pptx' })[0]
  $manifest = [ordered]@{
    schemaVersion = 1; manifestKind = 'recap-build'; runId = $runId; date = $Date; requestedDate = $Date
    startedAt = ([datetimeoffset]$runStart).ToUniversalTime().ToString('o'); completedAt = [datetimeoffset]::UtcNow.ToString('o')
    deckDataSha256 = [string]$deckDataInput.sha256; deckPptxSha256 = [string]$deckPptxInput.sha256
    status = 'complete'; inputs = $remoteInputs; pieces = $remotePieces
  }
  $buildErrors = @(Get-RecapManifestErrors $manifest $Date $inputRecords $pieces)
  if ($buildErrors.Count) { Fail ("completed build manifest is invalid: " + ($buildErrors -join '; ')) }
  $immutableManifestLocal = Join-Path $OUT "build-artifacts-$runId.json"
  try { Write-ImmutableJsonFile $manifest $immutableManifestLocal }
  catch { Fail "refusing to overwrite immutable build manifest $immutableManifestLocal - $($_.Exception.Message)" }
  Set-RecapManifestPointer $immutableManifestLocal $manifestPointerLocal
  $pendingRemote = "$NodeOut\BUILD.manifest.pending-$runId.json"
  $immutableRemote = "$NodeOut\build-artifacts-$runId.json"
  $pointerRemote = "$NodeOut\BUILD.manifest.json"
  NodePush $immutableManifestLocal $pendingRemote
  $safePendingRemote = $pendingRemote.Replace("'", "''")
  $safeImmutableRemote = $immutableRemote.Replace("'", "''")
  $safePointerRemote = $pointerRemote.Replace("'", "''")
  $promoteScript = Join-Path $env:TEMP "recap-manifest-promote-$runId.ps1"
  @"
`$ErrorActionPreference = 'Stop'
try {
  if (-not (Test-Path -LiteralPath '$safePendingRemote' -PathType Leaf)) { throw 'pending manifest did not land' }
  if (Test-Path -LiteralPath '$safeImmutableRemote') { throw 'immutable manifest already exists' }
  `$candidate = Get-Content -LiteralPath '$safePendingRemote' -Raw | ConvertFrom-Json
  if (`$candidate.manifestKind -ne 'recap-build' -or `$candidate.runId -ne '$runId' -or `$candidate.status -ne 'complete') { throw 'pending manifest identity is invalid' }
  Move-Item -LiteralPath '$safePendingRemote' -Destination '$safeImmutableRemote' -ErrorAction Stop
  `$tempPointer = '$safePointerRemote.$runId.tmp'
  `$backupPointer = '$safePointerRemote.$runId.backup'
  Copy-Item -LiteralPath '$safeImmutableRemote' -Destination `$tempPointer -Force
  try {
    if (Test-Path -LiteralPath '$safePointerRemote') { [IO.File]::Replace(`$tempPointer, '$safePointerRemote', `$backupPointer) }
    else { [IO.File]::Move(`$tempPointer, '$safePointerRemote') }
  } finally {
    if (Test-Path -LiteralPath `$backupPointer) { Remove-Item -LiteralPath `$backupPointer -Force -ErrorAction SilentlyContinue }
  }
  'MANIFEST_READY=' + (Get-FileHash -LiteralPath '$safePointerRemote' -Algorithm SHA256).Hash
} catch { 'MANIFEST_FAILED=' + `$_.Exception.Message; exit 1 }
"@ | Set-Content $promoteScript -Encoding ascii
  $promoteOut = NodeShell $promoteScript 45000
  $localManifestHash = (Get-FileHash -LiteralPath $immutableManifestLocal -Algorithm SHA256).Hash
  if ($promoteOut -notmatch 'MANIFEST_READY=([A-Fa-f0-9]{64})' -or $Matches[1] -ine $localManifestHash) { Fail "completed manifest was not atomically promoted on $Node - $(TransferError $promoteOut)" }
} else {
  NodePull "$NodeOut\BUILD.manifest.json" $manifestPointerLocal
  try { $manifest = Get-Content -LiteralPath $manifestPointerLocal -Raw | ConvertFrom-Json }
  catch { Fail "-SkipBuild requires a readable completed build manifest: $($_.Exception.Message)" }
}
$manifestErrors = @(Get-RecapManifestErrors $manifest $Date $inputRecords $pieces)
if ($manifestErrors.Count) { Fail ("build manifest does not authorize this run: " + ($manifestErrors -join '; ')) }
$runId = [string]$manifest.runId
$buildManifestName = "build-artifacts-$runId.json"
$canonicalBuildManifestLocal = Join-Path $OUT $buildManifestName
$pointerArtifact = Get-ArtifactRecord $buildManifestName $manifestPointerLocal
if (Test-Path -LiteralPath $canonicalBuildManifestLocal -PathType Leaf) {
  if (-not (Test-PieceMatchesArtifact $canonicalBuildManifestLocal $pointerArtifact)) { Fail "local immutable build manifest $buildManifestName disagrees with the node's completed-run pointer" }
} else { [IO.File]::Copy($manifestPointerLocal, $canonicalBuildManifestLocal, $false) }
$buildManifestArtifact = Get-ArtifactRecord $buildManifestName $canonicalBuildManifestLocal
Note "build provenance verified: run $runId, date $Date, all input and piece hashes complete"
try { $sharedNodeLease = Renew-SharedNodeLease $sharedNodeLease }
catch { Fail "shared render-node lease heartbeat failed before collection: $($_.Exception.Message)" }

# 5) COLLECT — pull the 4 pieces and COMBINE them here in the user's local space.
# Every reused or downloaded piece must equal the immutable manifest's byte length and SHA-256.
# Freshness remains an independent transfer guard for pieces downloaded during this invocation.
Note "pulling 4 pieces from node…"
$reusedPieces = @{}
foreach ($f in $pieces) {
  $localPiece = "$OUT\$f"
  $artifact = @($manifest.pieces | Where-Object { $_.name -ceq $f })[0]
  if ($ResumePull -and (Test-PieceMatchesArtifact $localPiece $artifact)) {
    $reusedPieces[$f] = $true
    Note "resume: $f belongs to completed run $runId (byte length + SHA-256 verified)"
  } else {
    NodePull "$NodeOut\$f" $localPiece
    if (-not (Test-PieceMatchesArtifact $localPiece $artifact)) { Fail "piece $f does not match completed run $runId; refusing to mix build artifacts" }
  }
}
foreach ($f in $pieces) {
  if (-not (Test-Path "$OUT\$f") -or (Get-Item "$OUT\$f").Length -lt 300KB) { Fail "piece missing/too small: $f (check $NodeOut\build.log on $Node)" }
  if (-not $reusedPieces.ContainsKey($f) -and (Get-Item "$OUT\$f").LastWriteTime -lt $runStart) { Fail "piece STALE: $f predates this run (pull failed silently; a prior day's clip must never ship as today's)" }
}
Note "combining (assemble-recap.js)…"; & node "$REPO\scripts\assemble-recap.js" 2>&1 | Tee-Object -FilePath $log -Append
$vid = "$OUT\trade-recap.mp4"
if (-not (Test-Path $vid) -or (Get-Item $vid).Length -lt 1MB) { Fail "assemble produced no/short trade-recap.mp4" }
Note "rendering PDF…"; $pdf = "$OUT\$Date.pdf"
$pp = New-Object -ComObject PowerPoint.Application
try { $pr = $pp.Presentations.Open("$OUT\deck.pptx", -1, 0, 0); $pr.SaveAs($pdf, 32); $pr.Close() } finally { $pp.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($pp) | Out-Null }

# Publishers consume RECAP.manifest.json, never a filename-only trio. It links the final bytes to
# the immutable build record so a deck/PDF/video from another date or run cannot be mixed in.
try {
  $outputRecords = @(
    Get-ArtifactRecord 'deck.pptx' "$OUT\deck.pptx"
    Get-ArtifactRecord "$Date.pdf" $pdf
    Get-ArtifactRecord 'trade-recap.mp4' $vid
  )
} catch { Fail "could not inventory final recap outputs: $($_.Exception.Message)" }
$deliveryId = [guid]::NewGuid().ToString('N')
$deliveryManifest = [ordered]@{
  schemaVersion = 1; manifestKind = 'recap-delivery'; runId = $runId; deliveryId = $deliveryId
  requestedDate = $Date; status = 'complete'; completedAt = [datetimeoffset]::UtcNow.ToString('o')
  buildManifest = $buildManifestArtifact; inputs = @($manifest.inputs); pieces = @($manifest.pieces); outputs = $outputRecords
}
$deliveryManifestLocal = Join-Path $OUT "recap-artifacts-$runId-$deliveryId.json"
try { Write-ImmutableJsonFile $deliveryManifest $deliveryManifestLocal }
catch { Fail "refusing to overwrite immutable delivery manifest $deliveryManifestLocal - $($_.Exception.Message)" }
$deliveryErrors = @(Get-DeliveryManifestErrors $deliveryManifest $OUT)
if ($deliveryErrors.Count) { Fail ("final delivery manifest is invalid: " + ($deliveryErrors -join '; ')) }
$deliveryPointerLocal = Join-Path $OUT 'RECAP.manifest.json'
Set-RecapManifestPointer $deliveryManifestLocal $deliveryPointerLocal
Note "delivery provenance verified: $deliveryPointerLocal binds deck, PDF, and final video to run $runId"

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
# data-driven off media/recaps/index.json, so this is files + one JSON prepend. Email/archive are
# durable before this step, but a missed site is still a failed nightly and must reach Task Scheduler.
try { $sharedNodeLease = Renew-SharedNodeLease $sharedNodeLease }
catch { Fail "shared render-node lease heartbeat failed before publication: $($_.Exception.Message)" }
Note "publishing to agenticfederal.us..."
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\publish-agenticfederal-recap.ps1" `
  -Date $Date -Out $OUT -Manifest $deliveryPointerLocal 2>&1 | Tee-Object -FilePath $log -Append
if ($LASTEXITCODE -ne 0) {
  Note "PUBLISH FAILED (recap emailed + archived fine; site not updated - run publish-agenticfederal-recap.ps1 -Date $Date manually)"
  try { docker exec oshal-local-api node /app/scripts/oshal-send-alert.js "OSHAL recap $Date - site publish FAILED" ("The recap emailed and archived fine, but the site publish failed - see " + $log + ". Re-run: powershell -File scripts/publish-agenticfederal-recap.ps1 -Date " + $Date) 2>&1 | Out-Null }
  catch { Note "publish-failure alert also failed: $($_.Exception.Message)" }
  exit 1
} else { Note "site publish verified live" }
Note "=== DONE: $Date recap emailed to the user (+ archived + published) ==="
} finally {
  # Token release cannot clear a successor; expiry is the crash-only recovery path. The host mutex
  # remains local defense-in-depth for shared staging files and is released after the node authority.
  Exit-SharedNodeLease $sharedNodeLease
  Exit-RecapRunLock $recapRunLock
}
