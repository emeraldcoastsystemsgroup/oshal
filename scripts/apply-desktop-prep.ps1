<#
  apply-desktop-prep.ps1 — operator-desktop helper for the apply-operator bot.

  Runs on the machine that hosts the swarm (Docker Desktop). It is the "worker == swarm host"
  path: it shells the per-user, OSHAL_USER_SUB-scoped tools inside the api container and pulls the
  approved packet's PDFs onto local disk so the bot (or you) can upload them through the real
  Chrome file picker. All data stays scoped to YOUR sub — it never reads another user's packets.

  Usage (set your sub once):
    $env:OSHAL_USER_SUB = "<your-oidc-sub>"
    .\scripts\apply-desktop-prep.ps1 next                 # fetch the next submittable job + its PDFs
    .\scripts\apply-desktop-prep.ps1 claim   <postingId>  # lock it so no other worker double-submits
    .\scripts\apply-desktop-prep.ps1 record  <postingId> applied|deferred|dismissed [note]
    .\scripts\apply-desktop-prep.ps1 code                 # newest ATS verification code from Gmail
    .\scripts\apply-desktop-prep.ps1 profile              # your canonical form values (never guess)

  (Remote workers that are NOT the swarm host use the authenticated /api/apply-operator bridge
   instead of docker exec — see docs/intelligent-career-automation/phase3-bringup.md.)
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('next', 'prep', 'claim', 'record', 'code', 'profile')]
  [string]$Cmd = 'next',
  [Parameter(Position = 1)][string]$Arg1,
  [Parameter(Position = 2)][string]$Arg2,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest,
  [string]$Sub = $env:OSHAL_USER_SUB,
  [string]$Container = 'oshal-local-api',
  [string]$WorkDir = (Join-Path (Split-Path $PSScriptRoot -Parent) '.apply-work')
)

if (-not $Sub) { Write-Error 'Set $env:OSHAL_USER_SUB (your OIDC sub) or pass -Sub <sub>.'; exit 2 }

function Invoke-Apply([string[]]$applyArgs) {
  docker exec -e "OSHAL_USER_SUB=$Sub" -w /app $Container node scripts/oshal-apply.js @applyArgs
}

switch ($Cmd) {
  { $_ -in 'next', 'prep' } {
    $raw = Invoke-Apply @('queue', 'next')
    $res = $raw | ConvertFrom-Json
    if (-not $res.item) { Write-Host "No submittable item ready. $($res.note)"; break }
    $it = $res.item
    $dest = Join-Path $WorkDir (Split-Path $it.packet_dir -Leaf)
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    docker cp "${Container}:$($it.resume_pdf)" (Join-Path $dest 'Resume_ATS.pdf') | Out-Null
    if ($it.cover_pdf)       { docker cp "${Container}:$($it.cover_pdf)" (Join-Path $dest 'CoverLetter.pdf') | Out-Null }
    if ($it.workday_autofill){ docker cp "${Container}:$($it.workday_autofill)" (Join-Path $dest 'Resume_Workday_Autofill.txt') | Out-Null }
    Write-Host ''
    Write-Host "JOB   : $($it.title)"
    Write-Host "AT    : $($it.company)   fit $($it.fit)   posting $($it.posting_id)"
    Write-Host "WHERE : $($it.location)"
    Write-Host "URL   : $($it.url)"
    Write-Host "DOCS  : $dest"
    Get-ChildItem $dest | ForEach-Object { Write-Host ("        {0}  ({1:N0} bytes)" -f $_.Name, $_.Length) }
    Write-Host ''
    Write-Host "NEXT  : review it, then  .\scripts\apply-desktop-prep.ps1 claim $($it.posting_id)"
    Write-Host "        (claim locks it so a second worker won't double-submit)"
  }
  'claim'   { if (-not $Arg1) { Write-Error 'claim needs <postingId>'; exit 2 }; Invoke-Apply @('queue', 'claim', $Arg1) }
  'record'  {
    if (-not $Arg1 -or -not $Arg2) { Write-Error 'record needs <postingId> <applied|deferred|dismissed> [note]'; exit 2 }
    $a = @('queue', 'record', $Arg1, $Arg2)
    if ($Rest) { $a += @('--note', ($Rest -join ' ')) }
    Invoke-Apply $a
  }
  'code'    { Invoke-Apply @('email-code') }
  'profile' { Invoke-Apply @('profile') }
}
