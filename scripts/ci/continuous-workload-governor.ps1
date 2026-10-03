<#
.SYNOPSIS
  Continuous build, analysis, and memory-saturation governor.
.DESCRIPTION
  Maintains active build, typecheck, and test-suite analysis workloads across
  oshal, oshal-applications, and oshal-app-private to keep memory actively utilized
  at target capacity (~88-92% utilization) while enforcing the strict >6% free RAM
  safety reserve. Continuously checks localhost portal health on port 3456.
.PARAMETER TargetUtilization
  Target memory utilization percentage (default: 88).
.PARAMETER MinFreePercent
  Hard safety floor for free physical memory (default: 6.0).
.PARAMETER PortalUrl
  Localhost portal healthcheck URL (default: http://localhost:3456).
.PARAMETER MaxIterations
  Maximum loop cycles (default: 0 for continuous daemon operation).
#>
[CmdletBinding()]
param(
  [double]$TargetUtilization = 88.0,
  [double]$MinFreePercent = 6.0,
  [string]$PortalUrl = 'http://localhost:3456',
  [int]$MaxIterations = 0
)

$ErrorActionPreference = 'Continue'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$receiptsDir = Join-Path $repoRoot 'artifacts\receipts'
if (-not (Test-Path $receiptsDir)) {
  New-Item -ItemType Directory -Path $receiptsDir -Force | Out-Null
}
$statusFile = Join-Path $receiptsDir 'workload-governor-status.json'

Write-Host "=== OSHAL Continuous Workload & Memory Governor ===" -ForegroundColor Cyan
Write-Host "Repo Root          : $repoRoot"
Write-Host "Target Utilization : $TargetUtilization%"
Write-Host "Safety Free RAM    : >$MinFreePercent%"
Write-Host "Portal Endpoint    : $PortalUrl"
Write-Host "Status Receipt     : $statusFile"
Write-Host "==================================================="

$workQueue = @(
  @{ Name = 'experience-gaps'; Cmd = 'npx vitest run tests/unit/experience-full-swarm-gaps.spec.ts'; Cwd = "$repoRoot" },
  @{ Name = 'feature-token-reader'; Cmd = 'npx vitest run tests/unit/feature-token-evidence-reader.spec.ts'; Cwd = "$repoRoot" },
  @{ Name = 'deploy-drift-rollback'; Cmd = 'npx vitest run tests/unit/deploy-drift-and-rollback.spec.ts'; Cwd = "$repoRoot" },
  @{ Name = 'openapi-catalog'; Cmd = 'npx vitest run tests/unit/connectors/openapi-and-catalog.spec.ts'; Cwd = "$repoRoot" },
  @{ Name = 'refusal-classification'; Cmd = 'npx vitest run tests/unit/refusal-classification.spec.ts'; Cwd = "$repoRoot" },
  @{ Name = 'crm-obligations'; Cmd = 'node --test capture-crm/tests/dashboard-obligations.test.js'; Cwd = 'c:\Projects\oshal-app-private' },
  @{ Name = 'store-catalog-integrity'; Cmd = 'node --check scripts/catalog-integrity.mjs'; Cwd = 'c:\Projects\oshal-applications' },
  @{ Name = 'source-typecheck'; Cmd = 'npx tsc -p tsconfig.json --noEmit'; Cwd = "$repoRoot" }
)

$jobIndex = 0
$iteration = 0
$activeJobs = @{}
$completedCount = 0
$passedCount = 0
$failedCount = 0

try {
  while ($MaxIterations -eq 0 -or $iteration -lt $MaxIterations) {
    $iteration++
    $timestamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')

    # 1. Measure Memory
    $os = Get-CimInstance Win32_OperatingSystem
    $totalMb = [math]::Round($os.TotalVisibleMemorySize / 1024, 2)
    $freeMb = [math]::Round($os.FreePhysicalMemory / 1024, 2)
    $freePercent = [math]::Round(($os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 2)
    $usedPercent = [math]::Round(100.0 - $freePercent, 2)

    # 2. Check Portal
    $portalStatus = 'UNREACHABLE'
    try {
      $req = Invoke-WebRequest -Uri $PortalUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      $portalStatus = "$($req.StatusCode) OK"
    } catch {
      $portalStatus = "ERR: $($_.Exception.Message)"
    }

    # 3. Clean finished background jobs
    $runningJobIds = @($activeJobs.Keys)
    foreach ($jid in $runningJobIds) {
      $j = Get-Job -Id $jid -ErrorAction SilentlyContinue
      if ($null -eq $j -or $j.State -in @('Completed', 'Failed', 'Stopped')) {
        $completedCount++
        if ($j.State -eq 'Completed') {
          $passedCount++
        } else {
          $failedCount++
        }
        $meta = $activeJobs[$jid]
        Write-Host "[$timestamp] Job finished: $($meta.Name) ($($j.State))" -ForegroundColor Gray
        Remove-Job -Job $j -Force -ErrorAction SilentlyContinue
        $activeJobs.Remove($jid)
      }
    }

    # 4. Memory Governor Decision
    # Can we spawn another job?
    if ($freePercent -le $MinFreePercent) {
      Write-Host "[$timestamp] RAM Safety Floor Reached ($freePercent% free <= $MinFreePercent% floor). Pausing spawn." -ForegroundColor Yellow
    } elseif ($usedPercent -lt $TargetUtilization -and $activeJobs.Count -lt 6) {
      # Spawn next workload item
      $spec = $workQueue[$jobIndex % $workQueue.Count]
      $jobIndex++
      
      $jobName = "$($spec.Name)-$iteration"
      $scriptBlock = [ScriptBlock]::Create("Set-Location '$($spec.Cwd)'; cmd /c '$($spec.Cmd)'")
      $job = Start-Job -Name $jobName -ScriptBlock $scriptBlock
      $activeJobs[$job.Id] = @{ Name = $spec.Name; StartedAt = $timestamp }
      Write-Host "[$timestamp] Spawned: $($spec.Name) (Active: $($activeJobs.Count), RAM: $usedPercent% used / $freePercent% free)" -ForegroundColor Green
    }

    # 5. Emit telemetry receipt
    $telemetry = [PSCustomObject]@{
      timestamp        = $timestamp
      iteration        = $iteration
      memory = [PSCustomObject]@{
        totalMb     = $totalMb
        freeMb      = $freeMb
        usedPercent = $usedPercent
        freePercent = $freePercent
      }
      portal = [PSCustomObject]@{
        url    = $PortalUrl
        status = $portalStatus
      }
      workloads = [PSCustomObject]@{
        activeJobs     = $activeJobs.Count
        completedCount = $completedCount
        passedCount    = $passedCount
        failedCount    = $failedCount
      }
    }

    $telemetry | ConvertTo-Json -Depth 4 | Set-Content -Path $statusFile -Encoding utf8

    if ($iteration % 5 -eq 1) {
      Write-Host "[$timestamp] Loop #$iteration | RAM: $usedPercent% used ($freeMb MB free) | Portal: $portalStatus | Jobs: $($activeJobs.Count) active, $passedCount passed" -ForegroundColor Cyan
    }

    Start-Sleep -Seconds 4
  }
} finally {
  Write-Host "Stopping active background workload jobs..." -ForegroundColor Yellow
  Get-Job | Where-Object { $_.Name -like '*-*' } | Stop-Job -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue
}
