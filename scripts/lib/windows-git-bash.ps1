# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Add one bounded, fail-closed Git for Windows Bash resolver for scheduled PowerShell jobs; reject System32/WSL launchers, require a non-empty BASH_VERSION plus an MSYS/MINGW runtime identity, and verify descendant cleanup when a timed probe must be stopped.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Stop orphaning spinning probes. Three orphans burned 20.6 CPU-hours over 17 hours on 2026-08-05/06 and starved the stack watchdog into its fail-closed branch on ten consecutive runs. Fixes: walk the probe tree with targeted per-parent queries instead of enumerating every process (the ~2s whole-table scan sat between the timeout and the first kill, and a host terminated in that window left the child spinning forever); terminate a live child in the finally before disposing its handle, because Dispose only releases the handle and every statement between Start-Process and WaitForExit could previously throw straight past any cleanup; reap marker-tagged probes older than any legal probe lifetime before starting a new one, so an orphan from a dead host cannot accumulate unnoticed; and raise cleanup-verification failures on the warning stream, since all three production callers run without -Verbose and the code was reporting its own leak where nobody listened.

function Test-OshalWindowsSubsystemBashPath([string]$Path) {
  if (-not $Path) { return $false }
  $normalized = $Path.Replace('/', '\')
  if ($normalized -match '(?i)\\(?:system32|sysnative|syswow64)\\bash\.exe$') { return $true }
  return $normalized -match '(?i)(?:^|\\)wsl\.exe$'
}

function Get-OshalGitBashCandidates {
  $candidates = New-Object 'System.Collections.Generic.List[string]'
  $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $git -and $git.Source) {
    $gitDir = Split-Path -Parent $git.Source
    $gitRoot = if ((Split-Path -Leaf $gitDir) -in @('cmd', 'bin')) {
      Split-Path -Parent $gitDir
    } else { $gitDir }
    [void]$candidates.Add((Join-Path $gitRoot 'bin\bash.exe'))
  }
  foreach ($root in @(
    $env:ProgramFiles,
    [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs' })
  )) {
    if ($root) { [void]$candidates.Add((Join-Path $root 'Git\bin\bash.exe')) }
  }
  return @($candidates | Select-Object -Unique)
}

function Get-OshalGitBashProbeTreeIds([int]$RootProcessId, [int]$MaxDepth = 4) {
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$ids.Add($RootProcessId)
  if ($env:OS -ne 'Windows_NT') { return @($RootProcessId) }
  # Query children per-parent rather than enumerating Win32_Process whole. The full scan cost up
  # to 2s and ran BEFORE the first kill, so a host terminated in that window (the Node spawnSync
  # timeout does exactly this) orphaned a probe that then spun on a core indefinitely. The probe
  # tree is a launcher stub plus its re-exec, so the depth bound is generous.
  $frontier = @($RootProcessId)
  for ($depth = 0; $depth -lt $MaxDepth -and $frontier.Count -gt 0; $depth++) {
    $next = @()
    foreach ($parentProcessId in $frontier) {
      $rows = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentProcessId" `
          -OperationTimeoutSec 1 -ErrorAction Stop | Select-Object ProcessId)
      foreach ($row in $rows) {
        $childProcessId = [int]$row.ProcessId
        if ($ids.Add($childProcessId)) { $next += $childProcessId }
      }
    }
    $frontier = $next
  }
  return @($ids | ForEach-Object { [int]$_ })
}

function Remove-OshalStaleGitBashProbes([int]$MinimumAgeSeconds = 120) {
  <#
    .SYNOPSIS
    Reaps marker-tagged Git Bash probes orphaned by an earlier run's terminated host.
    .DESCRIPTION
    Cleanup is otherwise entirely in-process, so a host killed mid-probe leaves a child nothing
    ever notices. Only probes older than any legal probe lifetime are reaped (ProbeTimeoutMs caps
    at 30s and worst-case cleanup adds ~15s), which keeps a concurrent run's live probe safe.
    .PARAMETER MinimumAgeSeconds
    Age past which a marker-tagged probe cannot belong to an in-flight resolve.
    .OUTPUTS
    System.Int32[] of reaped process IDs; empty when nothing was stale.
  #>
  if ($env:OS -ne 'Windows_NT') { return @() }
  try {
    $cutoff = (Get-Date).AddSeconds(-$MinimumAgeSeconds)
    # Match the probe's full invocation shape, not the bare marker: a shell that merely MENTIONS
    # the marker (a grep, an editor, this repo's own tooling) also carries it on its command line,
    # and this function kills what it matches.
    $stale = @(Get-CimInstance Win32_Process -Filter "Name='bash.exe'" -OperationTimeoutSec 2 -ErrorAction Stop |
        Where-Object {
          $_.CommandLine -like '*--noprofile --norc -c*printf __OSHAL_GIT_BASH__:*' -and
          $_.CreationDate -lt $cutoff
        })
  } catch {
    Write-Warning "Stale Git Bash probe sweep could not enumerate processes: $($_.Exception.Message)"
    return @()
  }
  $reaped = @()
  foreach ($orphan in $stale) {
    try { Stop-Process -Id $orphan.ProcessId -Force -ErrorAction Stop; $reaped += [int]$orphan.ProcessId }
    catch {
      if ($null -ne (Get-Process -Id $orphan.ProcessId -ErrorAction SilentlyContinue)) {
        Write-Warning "Stale Git Bash probe $($orphan.ProcessId) survived reaping: $($_.Exception.Message)"
      }
    }
  }
  if ($reaped.Count -gt 0) {
    Write-Warning "Reaped $($reaped.Count) stale Git Bash probe(s) orphaned by an earlier run: $($reaped -join ',')"
  }
  return $reaped
}

function Get-OshalLiveGitBashProbeIds([int[]]$ProcessIds) {
  $live = @()
  foreach ($processId in $ProcessIds) {
    if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { $live += $processId }
  }
  return $live
}

function Wait-OshalGitBashProbeTreeStopped([int[]]$ProcessIds, [int]$TimeoutMs) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  do {
    $live = @(Get-OshalLiveGitBashProbeIds $ProcessIds)
    if ($live.Count -eq 0) { return @() }
    Start-Sleep -Milliseconds 50
  } while ((Get-Date) -lt $deadline)
  return @(Get-OshalLiveGitBashProbeIds $ProcessIds)
}

function Stop-OshalGitBashProbeIds([int[]]$ProcessIds, [string]$Path) {
  $stopOrder = @($ProcessIds | Select-Object -Unique)
  [Array]::Reverse($stopOrder)
  foreach ($processId in $stopOrder) {
    try { Stop-Process -Id $processId -Force -ErrorAction Stop }
    catch { if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { Write-Verbose "Probe PID $processId could not be stopped for '$Path': $($_.Exception.Message)" } }
  }
}

function Invoke-OshalGitBashProbeTaskkill($Process, [string]$Path) {
  if ($env:OS -ne 'Windows_NT' -or $Process.HasExited) { return $false }
  $killer = $null
  try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $startInfo.Arguments = "/PID $($Process.Id) /T /F"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $killer = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $killer.WaitForExit(3000)) {
      $killer.Kill()
      [void]$killer.WaitForExit(1000)
      return $false
    }
    return $killer.ExitCode -eq 0
  } catch {
    Write-Verbose "Git Bash probe tree kill failed for '$Path': $($_.Exception.Message)"
    return $false
  } finally { if ($null -ne $killer) { $killer.Dispose() } }
}

function Stop-OshalGitBashProbe($Process, [string]$Path) {
  $treeKnown = $true
  try { $treeIds = @(Get-OshalGitBashProbeTreeIds $Process.Id) }
  catch { $treeKnown = $false; $treeIds = @($Process.Id); Write-Verbose "Probe tree enumeration failed for '$Path': $($_.Exception.Message)" }
  $taskkillOk = Invoke-OshalGitBashProbeTaskkill $Process $Path
  if (-not $taskkillOk -and $env:OS -eq 'Windows_NT') {
    try { $treeIds = @($treeIds + @(Get-OshalGitBashProbeTreeIds $Process.Id) | Select-Object -Unique); $treeKnown = $true }
    catch { Write-Verbose "Probe tree refresh failed for '$Path': $($_.Exception.Message)" }
  }
  if (-not $taskkillOk) { Stop-OshalGitBashProbeIds $treeIds $Path }
  if (-not $Process.HasExited) { try { $Process.Kill() } catch { Write-Verbose "Probe root kill failed for '$Path': $($_.Exception.Message)" } }
  [void]$Process.WaitForExit(2000)
  $survivors = @(Wait-OshalGitBashProbeTreeStopped $treeIds 3000)
  if ($survivors.Count -gt 0) { Stop-OshalGitBashProbeIds $survivors $Path; $survivors = @(Wait-OshalGitBashProbeTreeStopped $survivors 2000) }
  $verified = $survivors.Count -eq 0 -and ($taskkillOk -or $treeKnown)
  # Warning, not Verbose: all three production callers invoke the resolver without -Verbose, so a
  # leak announced on the verbose stream is a leak announced to nobody.
  if (-not $verified) { Write-Warning "Git Bash probe cleanup could not verify every descendant for '$Path'; live PIDs: $($survivors -join ',')" }
  return $verified
}

function Get-OshalGitBashVersionFromIdentity([string]$Output) {
  $line = [string](($Output -split "`r?`n") |
      Where-Object { $_ -like '__OSHAL_GIT_BASH__:*' } | Select-Object -Last 1)
  if (-not $line -or $line -notmatch '^__OSHAL_GIT_BASH__:([^:]*):([^:]*):([^:]+)$') { return $null }
  $version = $Matches[1].Trim()
  $msystem = $Matches[2].Trim()
  $uname = $Matches[3].Trim()
  if (-not $version) { return $null }
  if ($uname -notmatch '^(?:MINGW|MSYS)') { return $null }
  if ($msystem -notmatch '^(?:MINGW(?:32|64)?|MSYS|UCRT64|CLANG(?:32|64|ARM64)?)$') { return $null }
  return $version
}

function Remove-OshalGitBashProbeFiles([string[]]$Paths) {
  foreach ($temporaryPath in $Paths) {
    try { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction Stop }
    catch { Write-Verbose "Git Bash probe temporary-file cleanup failed for '$temporaryPath': $($_.Exception.Message)" }
  }
}

function Invoke-OshalGitBashVersionProbe([string]$Path, [int]$TimeoutMs) {
  $process = $null
  $stdoutPath = [IO.Path]::GetTempFileName()
  $stderrPath = [IO.Path]::GetTempFileName()
  try {
    # File-backed output cannot leave PowerShell waiting on an inherited MSYS pipe after timeout.
    $start = @{
      FilePath = $Path
      ArgumentList = '--noprofile --norc -c "printf __OSHAL_GIT_BASH__:%s $BASH_VERSION; printf :%s $MSYSTEM; printf :; uname -s 2>/dev/null"'
      PassThru = $true
      RedirectStandardOutput = $stdoutPath
      RedirectStandardError = $stderrPath
    }
    if ($env:OS -eq 'Windows_NT') { $start.WindowStyle = 'Hidden' }
    else { $start.NoNewWindow = $true }
    $process = Start-Process @start
    # PowerShell 5.1 drops ExitCode after a redirected child closes unless its native handle was
    # opened first. Retain it now so a fast non-zero impostor cannot pass on output alone.
    $process.EnableRaisingEvents = $true
    $null = $process.Handle
    if (-not $process.WaitForExit($TimeoutMs)) {
      $cleanupComplete = Stop-OshalGitBashProbe $process $Path
      if (-not $cleanupComplete) { Write-Warning "Git Bash probe timed out with incomplete process-tree cleanup: '$Path'" }
      return $null
    }
    $process.WaitForExit()
    $stdout = [IO.File]::ReadAllText($stdoutPath).Trim()
    $stderr = [IO.File]::ReadAllText($stderrPath).Trim()
    if ($process.ExitCode -ne 0) {
      Write-Verbose "Git Bash probe exited $($process.ExitCode) for '$Path': $stderr"
      return $null
    }
    $version = Get-OshalGitBashVersionFromIdentity $stdout
    if (-not $version) {
      Write-Verbose "Rejected non-MSYS/MINGW Bash identity for '$Path'"
      return $null
    }
    return $version
  } catch {
    Write-Verbose "Git Bash probe failed for '$Path': $($_.Exception.Message)"
    return $null
  } finally {
    if ($null -ne $process) {
      # Dispose only releases the handle. Every statement between Start-Process and WaitForExit can
      # throw (PowerShell 5.1 .Handle and .EnableRaisingEvents both can), and the catch above used
      # to return past any kill, leaving a live child with nothing tracking it. Treat a throwing
      # HasExited as still-running: reaping a dead PID is harmless, leaking a live one is not.
      $stillRunning = $false
      try { $stillRunning = -not $process.HasExited } catch { $stillRunning = $true }
      if ($stillRunning) { [void](Stop-OshalGitBashProbe $process $Path) }
      try { $process.Dispose() } catch { Write-Verbose "Git Bash probe dispose failed for '$Path': $($_.Exception.Message)" }
    }
    Remove-OshalGitBashProbeFiles @($stdoutPath, $stderrPath)
  }
}

function Resolve-OshalGitBash {
  <#
    .SYNOPSIS
    Resolves and validates Git for Windows Bash without accepting the WSL launcher.
    .DESCRIPTION
    Checks Git's installation root and known Git for Windows roots, then probes each existing
    candidate with a finite timeout. Returns null unless the candidate exits zero, reports a
    non-empty BASH_VERSION, and identifies as an MSYS/MINGW runtime rather than WSL. Passing
    CandidatePaths replaces discovery for executable tests.
    .PARAMETER CandidatePaths
    Optional ordered candidate list. When omitted, Git for Windows locations are discovered.
    .PARAMETER ProbeTimeoutMs
    Maximum wall-clock time for each Bash version probe.
    .OUTPUTS
    System.String for the first validated Git Bash executable, or null when none is safe.
  #>
  [CmdletBinding()]
  param(
    [string[]]$CandidatePaths,
    [ValidateRange(50, 30000)][int]$ProbeTimeoutMs = 3000
  )
  # Reap first: a probe that outlived its host burns a core until someone notices, and this must
  # happen before our own child exists so the sweep cannot target it.
  [void](Remove-OshalStaleGitBashProbes)
  $candidates = if ($PSBoundParameters.ContainsKey('CandidatePaths')) {
    @($CandidatePaths)
  } else { @(Get-OshalGitBashCandidates) }
  foreach ($candidate in @($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-OshalWindowsSubsystemBashPath $candidate) {
      Write-Verbose "Rejected System32/WSL Bash candidate: '$candidate'"
      continue
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try { $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).ProviderPath }
    catch { Write-Verbose "Git Bash candidate could not be resolved: '$candidate': $($_.Exception.Message)"; continue }
    if (Test-OshalWindowsSubsystemBashPath $resolved) {
      Write-Verbose "Rejected System32/WSL Bash target: '$resolved'"
      continue
    }
    if (Invoke-OshalGitBashVersionProbe $resolved $ProbeTimeoutMs) { return $resolved }
  }
  return $null
}
