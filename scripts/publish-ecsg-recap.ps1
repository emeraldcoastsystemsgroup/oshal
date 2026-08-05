<#
  publish-ecsg-recap.ps1 - mirror one provenance-bound recap to the company site.

  The manifest-authorized PDF/video are copied into a disposable origin/main clone, committed by
  exact path, pushed, and verified byte-for-byte in production. The operator's checkout is never
  switched or staged.

  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ | AUTHOR                                     | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Initial mirror with newest-first recap index.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Publish from current main and verify production artifacts.
  3 | maintainer@emeraldcoastsystemsgroup.com   | Restore the operator's original branch after publication.
  4 | maintainer@emeraldcoastsystemsgroup.com   | Read BOM-less JSON explicitly as UTF-8 under Windows PowerShell 5.1.
  5 | maintainer@emeraldcoastsystemsgroup.com   | Replace shared-checkout mutation with an isolated origin/main worktree; require the immutable delivery manifest; atomically update strict JSON; record run/delivery IDs and hashes; verify membership plus exact production bytes, including legitimate older backfills.
  6 | maintainer@emeraldcoastsystemsgroup.com   | Preserve retry diagnostics during production propagation instead of silently discarding verification failures.
  7 | maintainer@emeraldcoastsystemsgroup.com   | Use a disposable origin/main clone rather than registering a publication worktree against the operator repository.
  8 | maintainer@emeraldcoastsystemsgroup.com   | Derive the display label from the validated request date and reject ambiguous recap-index schemas before mutation.
  9 | maintainer@emeraldcoastsystemsgroup.com   | Revalidate the complete final index, including the new operator note, immediately before its atomic write.
  10 | maintainer@emeraldcoastsystemsgroup.com  | Publish and verify the PPTX addressed by the deck URL so deckSha256/deckBytes describe the bytes a visitor actually downloads.
  11 | maintainer@emeraldcoastsystemsgroup.com  | Freeze the manifest, linked build, deck, PDF, and video once so a concurrent recap cannot change delivery during the mirror.
  12 | maintainer@emeraldcoastsystemsgroup.com  | Validate the production index with the ECSG path policy and log each bounded artifact-download failure with its exact byte or hash reason.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Date,
  [string]$Out = 'C:\Projects\open-shal-swarm-harness-agent-llm\packages\oshal-vids-operator\out',
  [string]$SiteRepo = 'C:\Projects\emeraldcoastsystemsgroup',
  [string]$Manifest = '',
  [string]$Note = '',
  [switch]$SkipPush
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\recap-publication.ps1')

function Note2($message) { Write-Host ("[publish-ecsg] " + $message) }
function Fail($message) { throw [System.InvalidOperationException]::new([string]$message) }

function Add-EcsgRecapCommit([string]$Repo, [string[]]$Paths, [string]$Message, [bool]$Push) {
  & git -C $Repo add -- @Paths 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'git add failed for the exact ECSG recap paths' }
  & git -C $Repo diff --cached --quiet -- @Paths
  $diffExit = $LASTEXITCODE
  if ($diffExit -gt 1) { Fail 'git diff --cached failed for the ECSG recap paths' }
  if ($diffExit -eq 1) {
    & git -C $Repo commit -q -m $Message -- @Paths
    if ($LASTEXITCODE -ne 0) { Fail 'git commit failed' }
  } else { Note2 'nothing changed for this delivery; production will still be verified' }
  if (-not $Push) { Note2 '-SkipPush set: isolated commit was validated but not pushed'; return }
  & git -C $Repo push origin HEAD:main 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'git push failed (origin/main moved or credentials are unavailable)' }
}

function Test-EcsgProduction($Delivery, $DeckArtifact, $PdfArtifact, $VideoArtifact) {
  for ($attempt = 1; $attempt -le 18; $attempt++) {
    try {
      $indexUri = "https://emeraldcoastsystemsgroup.com/js/recaps.json?cb=$([guid]::NewGuid().ToString('N'))"
      $remoteIndex = Read-RemoteRecapIndex $indexUri 'ecsg' 'ECSG production recap index'
      $entry = @($remoteIndex.Entries | Where-Object {
        [string]$_.date -ceq [string]$Delivery.requestedDate -and
        [string]$_.runId -ceq [string]$Delivery.runId -and
        [string]$_.deliveryId -ceq [string]$Delivery.deliveryId
      }) | Select-Object -First 1
      if (-not (Test-RecapIndexEntry $entry $Delivery $DeckArtifact $PdfArtifact $VideoArtifact)) {
        throw 'production index is missing the exact delivery provenance entry'
      }
      $base = 'https://emeraldcoastsystemsgroup.com/downloads/recaps'
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
      Note2 "production verification attempt $attempt failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 10
  }
  return $false
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
  $recapsDir = Join-Path $repo 'downloads\recaps'
  if (-not (Test-Path -LiteralPath $recapsDir -PathType Container)) { Fail "missing ECSG recap directory: $recapsDir" }

  Copy-VerifiedRecapArtifact (Join-Path $Out 'deck.pptx') (Join-Path $recapsDir "$Date.pptx") $deckArtifact
  Copy-VerifiedRecapArtifact (Join-Path $Out "$Date.pdf") (Join-Path $recapsDir "$Date.pdf") $pdfArtifact
  Copy-VerifiedRecapArtifact (Join-Path $Out 'trade-recap.mp4') (Join-Path $recapsDir "$Date.mp4") $videoArtifact

  $indexPath = Join-Path $repo 'js\recaps.json'
  $index = Read-RecapJsonStrict $indexPath 'ECSG recap index'
  $existingEntries = @(Get-RecapIndexEntries $index 'ECSG recap index' 'ecsg')
  $entry = [ordered]@{
    date = $Date; label = $label; runId = [string]$delivery.runId; deliveryId = [string]$delivery.deliveryId
    deck = "/downloads/recaps/$Date.pptx"; video = "/downloads/recaps/$Date.mp4"
    deckSha256 = [string]$deckArtifact.sha256; deckBytes = [long]$deckArtifact.bytes
    pdfSha256 = [string]$pdfArtifact.sha256; pdfBytes = [long]$pdfArtifact.bytes
    videoSha256 = [string]$videoArtifact.sha256; videoBytes = [long]$videoArtifact.bytes
  }
  if ($Note) { $entry.note = $Note }
  $rest = @($existingEntries | Where-Object { [string]$_.date -cne $Date })
  $index = [ordered]@{ recaps = @(@($entry) + $rest | Sort-Object { [string]$_.date } -Descending) }
  [void](Get-RecapIndexEntries $index 'ECSG recap index' 'ecsg')
  Write-RecapJsonAtomic $indexPath $index
  Note2 "index bound $Date to run $($delivery.runId) / delivery $($delivery.deliveryId)"

  $paths = @("downloads/recaps/$Date.pptx", "downloads/recaps/$Date.pdf", "downloads/recaps/$Date.mp4", 'js/recaps.json')
  Add-EcsgRecapCommit $repo $paths ("demos: $label verified recap") (-not $SkipPush)
  if (-not $SkipPush) {
    if (-not (Test-EcsgProduction $delivery $deckArtifact $pdfArtifact $videoArtifact)) {
      Fail "production did not serve the exact manifest bytes for run $($delivery.runId) after 3 minutes"
    }
    Note2 "DONE + VERIFIED: production index and artifacts match run $($delivery.runId)"
  }
} catch {
  Write-Host ("[publish-ecsg] FAILED: " + $_.Exception.Message)
  $publishExit = 1
} finally {
  try { Remove-RecapPublicationCheckout $checkout }
  catch { Write-Host ("[publish-ecsg] FAILED: " + $_.Exception.Message); $publishExit = 1 }
  try { Remove-RecapDeliverySnapshot $deliverySnapshot }
  catch { Write-Host ("[publish-ecsg] FAILED: " + $_.Exception.Message); $publishExit = 1 }
}
exit $publishExit
