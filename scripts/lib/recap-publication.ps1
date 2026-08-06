# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared fail-closed publication primitives for daily recap publishers: verified delivery manifests, isolated Git worktrees, exact artifact copy/hash checks, strict and atomic JSON, and production byte verification.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Use a real same-volume backup path for Windows atomic replacement instead of an empty File.Replace backup argument.
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Publish from a disposable origin/main clone so the workflow never registers a second worktree or index against an operator's active repository.
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Validate recap-index array/object/date uniqueness before mutation so syntactically valid but ambiguous JSON fails closed.
# 5 | maintainer@emeraldcoastsystemsgroup.com   | Capture native Git exit status before applying PowerShell pipeline operators so a prior command cannot make a valid origin appear missing.
# 6 | maintainer@emeraldcoastsystemsgroup.com   | Verify and parse one locked delivery-manifest snapshot so replacing the mutable pointer during child verification cannot swap in unverified provenance.
# 7 | maintainer@emeraldcoastsystemsgroup.com   | Parse verifier JSON and require its manifest digest to equal the exact locked byte snapshot returned to the publisher.
# 8 | maintainer@emeraldcoastsystemsgroup.com   | Require JSON object roots and reject markup, controls, unsafe recap URLs, or mismatched date paths before preserving index entries.
# 9 | maintainer@emeraldcoastsystemsgroup.com   | Allow only the exact historical AgenticFederal recap origin used by legacy ECSG entries while continuing to reject arbitrary external URLs.
# 10 | maintainer@emeraldcoastsystemsgroup.com  | Freeze one verified manifest/build/output set for the full primary-plus-mirror transaction so a concurrent recap cannot split sites across deliveries.
# 11 | maintainer@emeraldcoastsystemsgroup.com  | Scope URL allowlists by destination: AgenticFederal remains local-only while ECSG alone accepts its exact historical AF links.
# 12 | maintainer@emeraldcoastsystemsgroup.com  | Validate both parsed PSCustomObject indexes and in-memory ordered dictionaries without confusing dictionary keys for missing properties.
# 13 | maintainer@emeraldcoastsystemsgroup.com  | Treat ordered-dictionary entries as structured objects during final in-memory validation, independent of PowerShell pipeline adaptation.
# 14 | maintainer@emeraldcoastsystemsgroup.com  | Bound production HTTP reads by declared lengths, retain exact mismatch diagnostics, and validate remote indexes with the destination-specific schema before provenance selection.
# 15 | maintainer@emeraldcoastsystemsgroup.com  | Enforce one wall-clock budget across connect and every response read so a byte-capped slow-drip server cannot keep production verification alive indefinitely.
# 16 | maintainer@emeraldcoastsystemsgroup.com  | Measure the total HTTP deadline with a monotonic stopwatch and recheck it after each read so clock rollback or a late successful read cannot escape the budget.

function Assert-RecapPublicationDate([string]$Date) {
  $parsed = [datetime]::MinValue
  $culture = [System.Globalization.CultureInfo]::InvariantCulture
  $styles = [System.Globalization.DateTimeStyles]::None
  if (-not [datetime]::TryParseExact($Date, 'yyyy-MM-dd', $culture, $styles, [ref]$parsed)) {
    throw "bad date '$Date' (want a real YYYY-MM-DD calendar date)"
  }
}

function Read-RecapJsonStrict([string]$Path, [string]$Label = 'JSON') {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label missing: $Path" }
  try {
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if (-not $raw.TrimStart().StartsWith('{')) { throw "$Label root must be an object" }
    $value = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch { throw "$Label is unreadable: $($_.Exception.Message)" }
  if ($null -eq $value -or $value -isnot [pscustomobject]) { throw "$Label root must be an object: $Path" }
  Write-Output -NoEnumerate $value
}

function Read-RecapJsonSnapshot($Stream, [string]$Label) {
  if ($Stream.Length -gt 10MB) { throw "$Label exceeds the 10 MB safety limit" }
  $bytes = New-Object byte[] ([int]$Stream.Length)
  $offset = 0
  while ($offset -lt $bytes.Length) {
    $count = $Stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($count -le 0) { throw "$Label ended before its declared length" }
    $offset += $count
  }
  try {
    $encoding = New-Object System.Text.UTF8Encoding($false, $true)
    $raw = $encoding.GetString($bytes)
    if (-not $raw.TrimStart().StartsWith('{')) { throw "$Label root must be an object" }
    $value = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch { throw "$Label is unreadable: $($_.Exception.Message)" }
  if ($null -eq $value -or $value -isnot [pscustomobject]) { throw "$Label root must be an object" }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  return [pscustomobject]@{ Value = $value; Sha256 = $hash }
}

function Get-RecapIndexEntries($Index, [string]$Label, [ValidateSet('agenticfederal', 'ecsg')][string]$Policy) {
  $isDictionary = $Index -is [Collections.IDictionary]
  if ($isDictionary) {
    $hasRecaps = $Index.Contains('recaps')
    $recaps = $Index['recaps']
  } else {
    $hasRecaps = $null -ne $Index.PSObject.Properties.Item('recaps')
    $recaps = $Index.recaps
  }
  if (-not $hasRecaps -or $recaps -isnot [System.Array]) {
    throw "$Label must contain a recaps array"
  }
  $seen = @{}
  foreach ($entry in @($recaps)) {
    if ($entry -isnot [pscustomobject] -and $entry -isnot [Collections.IDictionary]) {
      throw "$Label contains a non-object recap entry"
    }
    $date = [string]$entry.date
    Assert-RecapPublicationDate $date
    foreach ($field in @('label', 'note')) {
      $text = [string]$entry.$field
      if ($text.Length -gt 1000 -or $text -match '[<>\x00-\x08\x0B\x0C\x0E-\x1F]') {
        throw "$Label entry '$date' has unsafe $field text"
      }
    }
    $safePaths = if ($Policy -eq 'ecsg') { @{
      deck = "^(?:/downloads/recaps/$date\.(?:pdf|pptx)|https://agenticfederal\.us/media/recaps/$date\.(?:pdf|pptx))$"
      video = "^(?:/downloads/recaps/$date\.mp4|https://agenticfederal\.us/media/recaps/$date\.mp4)$"
      pdf = '^$'
    } } else { @{
      deck = "^recaps/$date\.pptx$"; video = "^recaps/$date\.mp4$"; pdf = "^recaps/$date\.pdf$"
    } }
    foreach ($field in @('deck', 'video', 'pdf')) {
      $path = [string]$entry.$field
      if ($path -and $path -notmatch $safePaths[$field]) { throw "$Label entry '$date' has unsafe $field path" }
    }
    if ($seen.ContainsKey($date)) { throw "$Label contains duplicate recap date '$date'" }
    $seen[$date] = $true
  }
  return @($recaps)
}

function Read-VerifiedRecapDelivery([string]$ManifestPath, [string]$ArtifactRoot, [string]$ExpectedDate, [string]$RunnerPath, [string]$VerifiedManifestCopy = '') {
  if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) { throw "delivery verifier missing: $RunnerPath" }
  $snapshot = Join-Path $env:TEMP ("oshal-recap-delivery-" + [guid]::NewGuid().ToString('N') + '.json')
  $stream = $null
  try {
    Copy-Item -LiteralPath $ManifestPath -Destination $snapshot -ErrorAction Stop
    # FileShare.Read lets the verifier open the snapshot but prevents a writer
    # from replacing the bytes between verification and this process's parse.
    $stream = [IO.File]::Open($snapshot, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $verify = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RunnerPath `
      -VerifyDeliveryManifest $snapshot -DeliveryArtifactRoot $ArtifactRoot 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "delivery manifest verification failed: $($verify.Trim())" }
    try {
      $verifyLine = @($verify -split '\r?\n' | Where-Object { $_.Trim() }) | Select-Object -Last 1
      $verifyResult = $verifyLine | ConvertFrom-Json -ErrorAction Stop
    } catch { throw "delivery verifier returned unreadable JSON: $($_.Exception.Message)" }
    $manifestSnapshot = Read-RecapJsonSnapshot $stream 'delivery manifest snapshot'
    if ($verifyResult.valid -ne $true -or [string]$verifyResult.manifestSha256 -ine [string]$manifestSnapshot.Sha256) {
      throw 'delivery verifier result does not match the locked manifest snapshot'
    }
    $delivery = $manifestSnapshot.Value
    if ([string]$delivery.requestedDate -cne $ExpectedDate) {
      throw "delivery manifest date '$($delivery.requestedDate)' does not match '$ExpectedDate'"
    }
    if ($VerifiedManifestCopy) { [IO.File]::Copy($snapshot, $VerifiedManifestCopy, $false) }
    return $delivery
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $snapshot) { Remove-Item -LiteralPath $snapshot -Force -ErrorAction SilentlyContinue }
  }
}

function Remove-RecapDeliverySnapshot($Snapshot) {
  if ($null -eq $Snapshot -or -not $Snapshot.Path) { return }
  $path = [IO.Path]::GetFullPath([string]$Snapshot.Path)
  $tempRoot = [IO.Path]::GetFullPath([string]$env:TEMP).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $leaf = Split-Path -Leaf $path
  if (-not $path.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or $leaf -notmatch '^oshal-recap-delivery-[a-f0-9]{32}$') {
    throw "refusing to remove unexpected delivery snapshot path: $path"
  }
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop }
}

function New-VerifiedRecapDeliverySnapshot([string]$ManifestPath, [string]$ArtifactRoot, [string]$ExpectedDate, [string]$RunnerPath) {
  $path = Join-Path $env:TEMP ("oshal-recap-delivery-" + [guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($path)
  $snapshot = [pscustomobject]@{ Path = $path; Manifest = (Join-Path $path 'RECAP.manifest.json'); Delivery = $null }
  try {
    $delivery = Read-VerifiedRecapDelivery $ManifestPath $ArtifactRoot $ExpectedDate $RunnerPath $snapshot.Manifest
    $buildName = "build-artifacts-$($delivery.runId).json"
    if ([string]$delivery.buildManifest.name -cne $buildName) { throw 'delivery build-manifest identity is invalid' }
    Copy-VerifiedRecapArtifact (Join-Path $ArtifactRoot $buildName) (Join-Path $path $buildName) $delivery.buildManifest
    foreach ($name in @('deck.pptx', "$ExpectedDate.pdf", 'trade-recap.mp4')) {
      $artifact = Get-RecapDeliveryArtifact $delivery $name
      Copy-VerifiedRecapArtifact (Join-Path $ArtifactRoot $name) (Join-Path $path $name) $artifact
    }
    $snapshot.Delivery = Read-VerifiedRecapDelivery $snapshot.Manifest $path $ExpectedDate $RunnerPath
    return $snapshot
  } catch {
    Remove-RecapDeliverySnapshot $snapshot
    throw
  }
}

function Get-RecapDeliveryArtifact($Delivery, [string]$Name) {
  $matches = @($Delivery.outputs | Where-Object { [string]$_.name -ceq $Name })
  if ($matches.Count -ne 1) { throw "delivery output '$Name' must appear exactly once" }
  $artifact = $matches[0]
  if ([string]$artifact.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or [long]$artifact.bytes -lt 1) {
    throw "delivery output '$Name' has invalid provenance"
  }
  return $artifact
}

function Test-RecapArtifactFile([string]$Path, $Artifact) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $Path
  if ([long]$item.Length -ne [long]$Artifact.bytes) { return $false }
  return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ieq [string]$Artifact.sha256)
}

function Move-RecapFileAtomic([string]$Pending, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Destination)) {
    [System.IO.File]::Move($Pending, $Destination)
    return
  }
  $backup = "$Destination.backup-$([guid]::NewGuid().ToString('N'))"
  try {
    [System.IO.File]::Replace($Pending, $Destination, $backup)
  } finally {
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
  }
}

function Copy-VerifiedRecapArtifact([string]$Source, [string]$Destination, $Artifact) {
  if (-not (Test-RecapArtifactFile $Source $Artifact)) { throw "source artifact does not match manifest: $Source" }
  $pending = "$Destination.pending-$([guid]::NewGuid().ToString('N'))"
  try {
    Copy-Item -LiteralPath $Source -Destination $pending -Force -ErrorAction Stop
    if (-not (Test-RecapArtifactFile $pending $Artifact)) { throw "copied artifact hash mismatch: $Destination" }
    Move-RecapFileAtomic $pending $Destination
  } finally {
    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue }
  }
}

function Write-RecapJsonAtomic([string]$Path, $Value) {
  $pending = "$Path.pending-$([guid]::NewGuid().ToString('N'))"
  try {
    $json = $Value | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($pending, $json, (New-Object System.Text.UTF8Encoding($false)))
    [void](Read-RecapJsonStrict $pending 'pending recap index')
    Move-RecapFileAtomic $pending $Path
  } finally {
    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force -ErrorAction SilentlyContinue }
  }
}

function New-RecapPublicationCheckout([string]$SourceRepo) {
  $source = (Resolve-Path -LiteralPath $SourceRepo -ErrorAction Stop).Path
  $originOutput = @(& git -C $source remote get-url origin 2>$null)
  $originExit = $LASTEXITCODE
  $origin = $originOutput | Select-Object -First 1
  if ($originExit -ne 0 -or -not $origin) { throw "origin remote is missing in $source" }
  $path = Join-Path $env:TEMP ("oshal-recap-publish-" + [guid]::NewGuid().ToString('N'))
  try {
    & git clone --quiet --branch main --single-branch --no-tags -- $origin $path 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $path '.git'))) {
      throw 'could not clone origin/main for isolated publication'
    }
    foreach ($key in @('user.name', 'user.email')) {
      $value = (& git -C $source config --get $key 2>$null | Select-Object -First 1)
      if ($value) { & git -C $path config $key $value }
    }
    return [pscustomobject]@{ Source = $source; Path = $path }
  } catch {
    if (Test-Path -LiteralPath $path) { Remove-RecapPublicationCheckout ([pscustomobject]@{ Path = $path }) }
    throw
  }
}

function Remove-RecapPublicationCheckout($Checkout) {
  if ($null -eq $Checkout -or -not $Checkout.Path) { return }
  $path = [IO.Path]::GetFullPath([string]$Checkout.Path)
  $tempRoot = [IO.Path]::GetFullPath([string]$env:TEMP).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $leaf = Split-Path -Leaf $path
  if (-not $path.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or $leaf -notmatch '^oshal-recap-publish-[a-f0-9]{32}$') {
    throw "refusing to remove unexpected publication checkout path: $path"
  }
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop }
}

function Save-BoundedRecapHttpResponse([string]$Uri, [string]$Destination, [long]$MaximumBytes, [long]$ExpectedBytes = -1, [int]$TimeoutMs = 45000) {
  if ($MaximumBytes -lt 1 -or ($ExpectedBytes -ne -1 -and $ExpectedBytes -lt 1)) {
    throw 'HTTP byte bounds must be positive'
  }
  if ($TimeoutMs -lt 100 -or $TimeoutMs -gt 45000) { throw 'HTTP timeout must be between 100 and 45000 milliseconds' }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $request = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Uri)
  $request.AllowAutoRedirect = $true
  $request.MaximumAutomaticRedirections = 5
  $request.Timeout = $TimeoutMs
  $request.ReadWriteTimeout = $TimeoutMs
  $request.KeepAlive = $false
  $response = $source = $destinationStream = $null
  try {
    $response = [System.Net.HttpWebResponse]$request.GetResponse()
    if ($timer.ElapsedMilliseconds -ge $TimeoutMs) { throw "HTTP response exceeded the $TimeoutMs-millisecond total deadline" }
    $declared = [long]$response.ContentLength
    # Requiring a declared boundary avoids consuming a probe byte past the
    # manifest cap merely to discover that a chunked response was oversized.
    if ($declared -lt 0) { throw 'response omitted Content-Length; refusing an unbounded download' }
    if ($declared -gt $MaximumBytes) { throw "declared response length $declared exceeds the $MaximumBytes-byte safety limit" }
    if ($ExpectedBytes -ne -1 -and $declared -ne $ExpectedBytes) {
      throw "declared response length $declared does not match manifest-declared $ExpectedBytes bytes"
    }
    $source = $response.GetResponseStream()
    $destinationStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = New-Object byte[] ([int][Math]::Max(1, [Math]::Min(65536L, $declared)))
    $received = 0L
    while ($received -lt $declared) {
      $remainingMs = [int]($TimeoutMs - $timer.ElapsedMilliseconds)
      if ($remainingMs -le 0) { throw "HTTP response exceeded the $TimeoutMs-millisecond total deadline after $received bytes" }
      if (-not $source.CanTimeout) { throw 'response stream cannot enforce the total HTTP deadline' }
      $source.ReadTimeout = [Math]::Max(1, $remainingMs)
      $wanted = [int][Math]::Min([long]$buffer.Length, $declared - $received)
      try { $count = $source.Read($buffer, 0, $wanted) }
      catch { throw "response stream failed after $received of $declared bytes: $($_.Exception.Message)" }
      if ($count -le 0) { throw "response ended after $received of $declared declared bytes" }
      $received += $count
      if ($timer.ElapsedMilliseconds -ge $TimeoutMs) { throw "HTTP response exceeded the $TimeoutMs-millisecond total deadline after $received bytes" }
      $destinationStream.Write($buffer, 0, $count)
    }
    return $received
  } finally {
    if ($null -ne $destinationStream) { $destinationStream.Dispose() }
    if ($null -ne $source) { $source.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
  }
}

function Read-RemoteRecapIndex([string]$Uri, [ValidateSet('agenticfederal', 'ecsg')][string]$Policy, [string]$Label) {
  $temp = Join-Path $env:TEMP ("oshal-recap-index-" + [guid]::NewGuid().ToString('N') + '.json')
  try {
    [void](Save-BoundedRecapHttpResponse $Uri $temp 1MB)
    $index = Read-RecapJsonStrict $temp $Label
    $entries = [object[]]@(Get-RecapIndexEntries $index $Label $Policy)
    return [pscustomobject]@{ Index = $index; Entries = $entries }
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
}

function Test-RemoteRecapArtifact([string]$Uri, $Artifact) {
  $temp = Join-Path $env:TEMP ("oshal-recap-verify-" + [guid]::NewGuid().ToString('N'))
  try {
    $expectedBytes = [long]$Artifact.bytes
    $expectedHash = [string]$Artifact.sha256
    if ($expectedBytes -lt 1 -or $expectedHash -notmatch '^[A-Fa-f0-9]{64}$') {
      throw 'remote artifact has invalid manifest provenance'
    }
    [void](Save-BoundedRecapHttpResponse $Uri $temp $expectedBytes $expectedBytes)
    $actualHash = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ine $expectedHash) {
      throw "SHA-256 mismatch for '$Uri' (expected $($expectedHash.ToLowerInvariant()), got $actualHash)"
    }
    return $true
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
}

function Get-RemoteRecapArtifactFailures([object[]]$Checks) {
  $failures = @()
  foreach ($check in $Checks) {
    try { [void](Test-RemoteRecapArtifact ([string]$check.Uri) $check.Artifact) }
    catch {
      # Preserve the label and low-level length/hash reason so the publisher's
      # single retry log identifies every artifact that failed this attempt.
      $failures += "$($check.Label): $($_.Exception.Message)"
    }
  }
  return @($failures)
}

function Test-RecapIndexEntry($Entry, $Delivery, $DeckArtifact, $PdfArtifact, $VideoArtifact) {
  if ($null -eq $Entry) { return $false }
  return (
    [string]$Entry.runId -ceq [string]$Delivery.runId -and
    [string]$Entry.deliveryId -ceq [string]$Delivery.deliveryId -and
    [string]$Entry.deckSha256 -ieq [string]$DeckArtifact.sha256 -and
    [long]$Entry.deckBytes -eq [long]$DeckArtifact.bytes -and
    [string]$Entry.pdfSha256 -ieq [string]$PdfArtifact.sha256 -and
    [long]$Entry.pdfBytes -eq [long]$PdfArtifact.bytes -and
    [string]$Entry.videoSha256 -ieq [string]$VideoArtifact.sha256 -and
    [long]$Entry.videoBytes -eq [long]$VideoArtifact.bytes
  )
}
