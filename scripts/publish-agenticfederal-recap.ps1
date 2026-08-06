<#
  publish-agenticfederal-recap.ps1 - publish one provenance-bound trade recap.

  The delivery manifest is the authority. Generic filenames alone never authorize publication.
  Work happens in a disposable clone of origin/main, so an operator's current branch, staged files,
  and uncommitted site work cannot enter the recap commit or Cloudflare upload.

  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ | AUTHOR                                     | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Make the ECSG mirror part of the verified publish contract. A failed or missing mirror now returns non-zero instead of allowing the nightly to claim all sites were current.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Allow three minutes for custom-domain propagation after a Pages deploy.
  3 | maintainer@emeraldcoastsystemsgroup.com   | Read BOM-less JSON explicitly as UTF-8 under Windows PowerShell 5.1.
  4 | maintainer@emeraldcoastsystemsgroup.com   | Fail closed on an immutable recap delivery manifest; publish exact verified paths from an isolated origin/main worktree; atomically update strict JSON; record run/delivery IDs plus output hashes; verify production bytes; never touch or commit the operator's working branch.
  5 | maintainer@emeraldcoastsystemsgroup.com   | Preserve retry diagnostics during production propagation instead of silently discarding verification failures.
  6 | maintainer@emeraldcoastsystemsgroup.com   | Use a disposable origin/main clone rather than registering a publication worktree against the operator repository.
  7 | maintainer@emeraldcoastsystemsgroup.com   | Derive the display label from the validated request date and reject ambiguous recap-index schemas before mutation.
  8 | maintainer@emeraldcoastsystemsgroup.com   | Revalidate the complete final index, including the newly constructed entry, immediately before its atomic write.
  9 | maintainer@emeraldcoastsystemsgroup.com   | Freeze the manifest, linked build, deck, PDF, and video once and pass that same snapshot through the required ECSG mirror.
  10 | maintainer@emeraldcoastsystemsgroup.com  | Deploy a fresh origin/main clone and re-deploy in a bounded loop when main advances during upload, preventing an older snapshot from rolling production back.
  11 | maintainer@emeraldcoastsystemsgroup.com  | Validate the production index with the AgenticFederal path policy and log each bounded artifact-download failure with its exact byte or hash reason.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Date,
  [string]$SiteRepo = 'C:\Projects\agenticfederal',
  [string]$Out = 'C:\Projects\open-shal-swarm-harness-agent-llm\packages\oshal-vids-operator\out',
  [string]$Manifest = '',
  [switch]$SkipDeploy,
  [switch]$SkipMirror,
  [switch]$SkipJournal
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\recap-publication.ps1')

function Note($message) { Write-Host ("[publish-af] " + $message) }
function Fail($message) { throw [System.InvalidOperationException]::new([string]$message) }

function Add-RecapCommit([string]$Repo, [string[]]$Paths, [string]$Message) {
  & git -C $Repo add -- @Paths 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'git add failed for the exact recap paths' }
  & git -C $Repo diff --cached --quiet -- @Paths
  $diffExit = $LASTEXITCODE
  if ($diffExit -gt 1) { Fail 'git diff --cached failed for the recap paths' }
  if ($diffExit -eq 0) { Note 'no media changes to commit'; return $false }
  & git -C $Repo commit -q -m $Message -- @Paths
  if ($LASTEXITCODE -ne 0) { Fail 'git commit failed' }
  & git -C $Repo push origin HEAD:main 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'git push failed (origin/main moved or credentials are unavailable)' }
  Note 'pushed provenance-bound recap commit to GitHub'
  return $true
}

function Test-AgenticFederalProduction($Delivery, $DeckArtifact, $PdfArtifact, $VideoArtifact) {
  for ($attempt = 1; $attempt -le 18; $attempt++) {
    try {
      $indexUri = "https://agenticfederal.us/media/recaps/index.json?cb=$([guid]::NewGuid().ToString('N'))"
      $remoteIndex = Read-RemoteRecapIndex $indexUri 'agenticfederal' 'AgenticFederal production recap index'
      $entry = @($remoteIndex.Entries | Where-Object {
        [string]$_.date -ceq [string]$Delivery.requestedDate -and
        [string]$_.runId -ceq [string]$Delivery.runId -and
        [string]$_.deliveryId -ceq [string]$Delivery.deliveryId
      }) | Select-Object -First 1
      if (-not (Test-RecapIndexEntry $entry $Delivery $DeckArtifact $PdfArtifact $VideoArtifact)) {
        throw 'production index is missing the exact delivery provenance entry'
      }
      $base = 'https://agenticfederal.us/media/recaps'
      $checks = @(
        @{ Label = 'deck'; Uri = "$base/$($Delivery.requestedDate).pptx?cb=$attempt"; Artifact = $DeckArtifact },
        @{ Label = 'PDF'; Uri = "$base/$($Delivery.requestedDate).pdf?cb=$attempt"; Artifact = $PdfArtifact },
        @{ Label = 'video'; Uri = "$base/$($Delivery.requestedDate).mp4?cb=$attempt"; Artifact = $VideoArtifact }
      )
      $failures = @(Get-RemoteRecapArtifactFailures $checks)
      if ($failures.Count -gt 0) { throw "artifact verification failed: $($failures -join '; ')" }
      return $true
    } catch {
      # Propagation is expected to be transient, but the reason for each retry
      # remains visible so a terminal verification failure is diagnosable.
      Note "production verification attempt $attempt failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 10
  }
  return $false
}

function Invoke-StableAgenticFederalDeploy([string]$SiteRepo, [string]$RequiredCommit) {
  foreach ($attempt in 1..3) {
    $deployCheckout = $null
    try {
      $deployCheckout = New-RecapPublicationCheckout $SiteRepo
      $deployRepo = $deployCheckout.Path
      & git -C $deployRepo merge-base --is-ancestor $RequiredCommit HEAD 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'origin/main no longer contains the verified recap commit' }
      $deployedHead = (& git -C $deployRepo rev-parse HEAD).Trim()
      Note "deploying origin/main $deployedHead to Cloudflare Pages (attempt $attempt/3)..."
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $deployRepo 'scripts\deploy-cloudflare-pages.ps1')
      if ($LASTEXITCODE -ne 0) { throw 'wrangler deploy failed' }
      & git -C $deployRepo fetch origin main --quiet
      if ($LASTEXITCODE -ne 0) { throw 'could not verify origin/main after deployment' }
      $currentHead = (& git -C $deployRepo rev-parse refs/remotes/origin/main).Trim()
      if ($currentHead -eq $deployedHead) { return }
      Note "origin/main advanced to $currentHead during deployment; retrying from the newer commit"
    } finally { Remove-RecapPublicationCheckout $deployCheckout }
  }
  throw 'origin/main changed during all three deployment attempts; refusing to claim a stable publish'
}

$checkout = $null
$deliverySnapshot = $null
$publishExit = 0
try {
  Assert-RecapPublicationDate $Date
  if (-not $Manifest) { $Manifest = Join-Path $Out 'RECAP.manifest.json' }
  $runner = Join-Path $PSScriptRoot 'run-daily-recap.ps1'
  $deliverySnapshot = New-VerifiedRecapDeliverySnapshot $Manifest $Out $Date $runner
  $Out = $deliverySnapshot.Path
  $Manifest = $deliverySnapshot.Manifest
  $delivery = $deliverySnapshot.Delivery
  $deckArtifact = Get-RecapDeliveryArtifact $delivery 'deck.pptx'
  $pdfArtifact = Get-RecapDeliveryArtifact $delivery "$Date.pdf"
  $videoArtifact = Get-RecapDeliveryArtifact $delivery 'trade-recap.mp4'

  # The label is provenance-neutral presentation metadata. Deriving it from the
  # validated date prevents a mutable deck-data file from relabeling verified bytes.
  $parsedDate = [datetime]::ParseExact($Date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  $label = $parsedDate.ToString('MMMM d, yyyy', [Globalization.CultureInfo]::InvariantCulture)
  $checkout = New-RecapPublicationCheckout $SiteRepo
  $repo = $checkout.Path
  $recapsDir = Join-Path $repo 'media\recaps'
  if (-not (Test-Path -LiteralPath $recapsDir -PathType Container)) { Fail "missing recap directory: $recapsDir" }

  Copy-VerifiedRecapArtifact (Join-Path $Out 'trade-recap.mp4') (Join-Path $recapsDir "$Date.mp4") $videoArtifact
  Copy-VerifiedRecapArtifact (Join-Path $Out 'deck.pptx') (Join-Path $recapsDir "$Date.pptx") $deckArtifact
  Copy-VerifiedRecapArtifact (Join-Path $Out "$Date.pdf") (Join-Path $recapsDir "$Date.pdf") $pdfArtifact
  Copy-VerifiedRecapArtifact (Join-Path $Out 'trade-recap.mp4') (Join-Path $repo 'media\trade-recap.mp4') $videoArtifact
  Copy-VerifiedRecapArtifact (Join-Path $Out 'deck.pptx') (Join-Path $repo 'media\trade-recap-deck.pptx') $deckArtifact

  $indexPath = Join-Path $recapsDir 'index.json'
  $index = Read-RecapJsonStrict $indexPath 'AgenticFederal recap index'
  $existingEntries = @(Get-RecapIndexEntries $index 'AgenticFederal recap index' 'agenticfederal')
  $entry = [ordered]@{
    date = $Date; label = $label; runId = [string]$delivery.runId; deliveryId = [string]$delivery.deliveryId
    deck = "recaps/$Date.pptx"; video = "recaps/$Date.mp4"; pdf = "recaps/$Date.pdf"
    deckSha256 = [string]$deckArtifact.sha256; deckBytes = [long]$deckArtifact.bytes
    pdfSha256 = [string]$pdfArtifact.sha256; pdfBytes = [long]$pdfArtifact.bytes
    videoSha256 = [string]$videoArtifact.sha256; videoBytes = [long]$videoArtifact.bytes
  }
  $rest = @($existingEntries | Where-Object { [string]$_.date -cne $Date })
  $index = [ordered]@{ recaps = @(@($entry) + $rest | Sort-Object { [string]$_.date } -Descending) }
  [void](Get-RecapIndexEntries $index 'AgenticFederal recap index' 'agenticfederal')
  Write-RecapJsonAtomic $indexPath $index
  Note "index.json: bound $Date to run $($delivery.runId) / delivery $($delivery.deliveryId)"

  $paths = @(
    "media/recaps/$Date.mp4", "media/recaps/$Date.pptx", "media/recaps/$Date.pdf",
    'media/recaps/index.json', 'media/trade-recap.mp4', 'media/trade-recap-deck.pptx'
  )
  [void](Add-RecapCommit $repo $paths "recap $Date - verified daily trade recap")
  $publishedCommit = (& git -C $repo rev-parse HEAD).Trim()

  if ($SkipDeploy) { Note '-SkipDeploy set: Git was updated, but AgenticFederal Cloudflare upload and production verification were skipped' }
  else {
    # Publication and deployment use separate disposable clones. Re-cloning here
    # makes origin/main, rather than a now-stale pre-push checkout, authoritative.
    Remove-RecapPublicationCheckout $checkout
    $checkout = $null
    Invoke-StableAgenticFederalDeploy $SiteRepo $publishedCommit
    if (-not (Test-AgenticFederalProduction $delivery $deckArtifact $pdfArtifact $videoArtifact)) {
      Fail "production did not serve the exact manifest bytes for run $($delivery.runId) after 3 minutes"
    }
    Note "VERIFIED: production index and all three artifact hashes match run $($delivery.runId)"
  }

  if ($SkipJournal) { Note '-SkipJournal set: report journal bookkeeping was skipped' }
  else {
    try {
      $journalArgs = @('exec', '-e', "OSHAL_USER_SUB=$($env:OSHAL_USER_SUB)", 'oshal-local-api', 'node',
        '/app/scripts/oshal-report-journal.js', "--day=$Date", '--video=true')
      $journal = & docker @journalArgs 2>&1 | Out-String
      Note ("journal: " + (($journal -split "`n" | Where-Object { $_ -match 'REPORT_JOURNAL' } | Select-Object -Last 1)))
    } catch { Note "journal entry failed (publication remains valid): $($_.Exception.Message)" }
  }

  if ($SkipMirror) { Note '-SkipMirror set: ECSG mirror was explicitly skipped' }
  else {
    $mirror = Join-Path $PSScriptRoot 'publish-ecsg-recap.ps1'
    if (-not (Test-Path -LiteralPath $mirror -PathType Leaf)) { Fail "company-site mirror script missing: $mirror" }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $mirror -Date $Date -Out $Out -Manifest $Manifest 2>&1 | ForEach-Object { Note $_ }
    if ($LASTEXITCODE -ne 0) { Fail 'company-site mirror failed after the primary publication' }
  }
  Note "DONE: $Date published from delivery $($delivery.deliveryId)"
} catch {
  Write-Host ("[publish-af] FAILED: " + $_.Exception.Message)
  $publishExit = 1
} finally {
  try { Remove-RecapPublicationCheckout $checkout }
  catch { Write-Host ("[publish-af] FAILED: " + $_.Exception.Message); $publishExit = 1 }
  try { Remove-RecapDeliverySnapshot $deliverySnapshot }
  catch { Write-Host ("[publish-af] FAILED: " + $_.Exception.Message); $publishExit = 1 }
}
exit $publishExit
