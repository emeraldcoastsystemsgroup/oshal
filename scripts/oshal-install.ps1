<#
  oshal-install.ps1 - the native Windows installer for the OSHAL swarm.

  Double-click entry: Install-OSHAL.bat (beside this file, or downloaded alone - it fetches
  this script). No Git Bash required; PowerShell 5.1+ only.

  What it does: checks Docker (offers a winget install of Docker Desktop when absent), pulls the
  prebuilt image from GHCR (or loads an OFFLINE swarm-snapshot archive), extracts the baked
  compose.dist.yml + non-secret config seeds, generates operator-local secrets into .env, brings
  the swarm up ORDERED AND BATCHED (infra healthy -> api fully up -> bots five at a time - a mass
  cold-start OOMs small Docker engines), then opens the cockpit and prints the superadmin steps.

  Usage:
    .\scripts\oshal-install.ps1                          # interactive
    .\scripts\oshal-install.ps1 -Bundle gaming -AdminEmail you@example.com
    .\scripts\oshal-install.ps1 -FromArchive C:\Downloads\oshal-swarm-offline.tar   # no internet
    .\scripts\oshal-install.ps1 -Dir D:\oshal -Tag 2.1.0-beta.1 -DryRun

  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - native PowerShell port of scripts/oshal-install.sh (registry mode + bundles + dedup + superadmin + cockpit-open), plus -FromArchive: install from an offline swarm-snapshot tarball (docker load) with zero registry/network dependency. Bundles mirror the bash installer exactly; keep the two in lockstep.
  2 | maintainer@emeraldcoastsystemsgroup.com   | First-run fix - the install never asked WHO the user is, and the closing instructions were false. MOCK_OIDC has no sign-in page; it fabricates alex@demo.local / mock-user-001 and treats every request as authenticated, so "sign in at the cockpit with your email" could never happen and the user was silently someone else - not the superadmin, with every connector token binding to the shared demo sub. Now prompts for the email up front (skippable, interactive hosts only) and writes MOCK_OIDC_EMAIL/NAME/SUB alongside OSHAL_OPERATOR_EMAILS, with the sub derived as a stable hash of the email so a reinstall against the same workspace volume keeps its sub-keyed data. Also opens /welcome rather than /cockpit/ (linking an AI model is mandatory and browser-only - the cockpit just 302s to the wizard anyway) and states plainly what the wizard will ask for.
  3 | maintainer@emeraldcoastsystemsgroup.com   | CORE-05: add the explicit -NoAi posture and invoke the exact shipped oshal-verify.sh inside the image, including every deduplicated app smoke, after native Windows health checks.
  4 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: route package staging through the core installer so invalid audit bindings fail and enforce mode replaces packages from the exact audited SHA.
#>
[CmdletBinding()]
param(
  [string]$Bundle = "full",
  [string]$Apps = "",
  [string]$Dir = ".\oshal",
  [string]$Tag = "latest",
  [string]$Registry = "ghcr.io/emeraldcoastsystemsgroup",
  [string]$AdminEmail = "",
  [string]$FromArchive = "",
  [string]$PackageAuditMode = "",
  [switch]$NoAi,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if (-not $PackageAuditMode) { $PackageAuditMode = if ($env:OSHAL_PACKAGE_AUDIT_MODE) { $env:OSHAL_PACKAGE_AUDIT_MODE } else { 'compatible' } }
$PackageAuditMode = $PackageAuditMode.Trim().ToLowerInvariant()
if ($PackageAuditMode -notin @('compatible', 'enforce')) { throw "PackageAuditMode must be compatible or enforce" }

function Say([string]$m)  { Write-Host "`n== $m" -ForegroundColor Cyan }
function Note([string]$m) { Write-Host "   $m" }

# -- Bundles: kernel + curated sets, dependencies bound (keep in lockstep with oshal-install.sh) --
$KernelServices = @('oshal-api','general-bot','jarvis-bot','oshal-developer')
$BundlePackages = @{ kernel=@(); full=@(); 'little-monsters'=@('little-monsters','presentations'); gaming=@('dnd','game-show'); jobs=@('career-hunter','job-apply') }
$BundleServices = @{ kernel=@(); full=@('__ALL__'); 'little-monsters'=@('deck-builder-bot'); gaming=@(); jobs=@() }
# No bundle sets a compose profile. ADR-085 carved little-monsters to the store and its compose
# profile went with it - the declared profiles are build/extras/incident/local-llm/
# social-media/tunnel, so COMPOSE_PROFILES=little-monsters activated nothing. Kept as a map
# because bundles that DO need a profile are a live possibility.
$BundleProfiles = @{ kernel=''; full=''; 'little-monsters'=''; gaming=''; jobs='' }
if (-not $BundlePackages.ContainsKey($Bundle)) { throw "unknown bundle '$Bundle' (kernel|full|little-monsters|gaming|jobs)" }

# Deduped package set: bundle union -Apps. A package stages once; a bot/surface registers once.
$pkgSet = New-Object System.Collections.Generic.HashSet[string]
foreach ($p in $BundlePackages[$Bundle]) { [void]$pkgSet.Add($p) }
foreach ($p in ($Apps -split ',')) { if ($p.Trim()) { [void]$pkgSet.Add($p.Trim()) } }

# -- Docker present? Offer winget when it isn't. -----------------------------
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
  Say "Docker is not installed"
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget -and -not $DryRun) {
    $ans = Read-Host "   Install Docker Desktop now via winget? [Y/n]"
    if ($ans -eq '' -or $ans -match '^[Yy]') {
      winget install --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
      Note "Docker Desktop installed. START IT once (it finishes setup on first launch), then re-run this installer."
    } else { Note "Install Docker Desktop from https://docs.docker.com/get-docker/ and re-run." }
  } else { Note "Install Docker Desktop from https://docs.docker.com/get-docker/ and re-run." }
  exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker is installed but the engine is not running - start Docker Desktop and re-run." }

$Image = "$Registry/oshal-bot:$Tag"
if ($DryRun) {
  Say "DRY RUN"
  Note "mode   : $(if ($FromArchive) { "offline archive: $FromArchive" } else { "registry pull: $Image" })"
  Note "bundle : $Bundle   packages: $(if ($pkgSet.Count) { $pkgSet -join ', ' } else { '(none)' })"
  Note "audit  : $PackageAuditMode"
  Note "no AI : $($NoAi.IsPresent)"
  Note "dir    : $Dir"
  exit 0
}

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Dir = (Resolve-Path $Dir).Path

# -- Get the image: offline snapshot or registry -----------------------------
if ($FromArchive) {
  if (-not (Test-Path $FromArchive)) { throw "archive not found: $FromArchive" }
  Say "loading the offline swarm snapshot (docker load - no network needed)"
  docker load -i $FromArchive
  if ($LASTEXITCODE -ne 0) { throw "docker load failed" }
} else {
  Say "pulling $Image (first pull is a few GB - one-time)"
  if ($env:GHCR_TOKEN) {
    $ghcrUser = if ($env:GHCR_USER) { $env:GHCR_USER } else { 'emeraldcoastsystemsgroup' }
    $env:GHCR_TOKEN | docker login ghcr.io -u $ghcrUser --password-stdin
  }
  docker pull $Image
  if ($LASTEXITCODE -ne 0) { throw "docker pull failed - is the package public / are you logged in?" }
}

# -- Extract the baked install artifacts -------------------------------------
Say "staging install dir: $Dir"
$cid = (docker create $Image).Trim()
try {
  docker cp "${cid}:/app/compose.dist.yml" (Join-Path $Dir 'compose.dist.yml') | Out-Null
  if (-not (Test-Path (Join-Path $Dir 'config-seed'))) {
    docker cp "${cid}:/app/config-seed.dist" (Join-Path $Dir 'config-seed') | Out-Null
  } else { Note "config-seed\ already exists - keeping yours" }
} finally { docker rm -f $cid *> $null }

# -- Who is the operator? ----------------------------------------------------
# Asked HERE, before anything is written, because MOCK_OIDC does NOT present a sign-in page:
# it fabricates a fixed identity (alex@demo.local / mock-user-001) and treats every request as
# already authenticated. Without this prompt a first-run user is silently signed in as someone
# else's demo account - never themselves, never the superadmin - and every account they connect
# binds to that shared demo sub. One question here is what makes the swarm actually theirs.
$envFile = Join-Path $Dir '.env'
if (-not $AdminEmail -and -not (Test-Path $envFile) -and [Environment]::UserInteractive) {
  Say "who owns this swarm?"
  Note "Your email becomes your local login AND makes you the superadmin. Nothing is sent"
  Note "anywhere - it is written only to your local .env. Press Enter to skip."
  $AdminEmail = (Read-Host "   your email").Trim()
}

# -- .env: generated once, never overwritten ---------------------------------
function Rand48 { -join ((1..48) | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] }) }

# Stable local identity derived from the email, so a reinstall against the same workspace volume
# keeps the same user sub (connector tokens and tickets are sub-keyed - a fresh random sub would
# orphan them). Deterministic hash, not a GUID, for exactly that reason.
function LocalSub([string]$email) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($email.ToLower()))
    $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    return 'local-' + $hex.Substring(0, 16)
  } finally { $sha.Dispose() }
}

if (-not (Test-Path $envFile)) {
  Say "generating .env (fresh secrets; MOCK_OIDC=true for local login)"
  $lines = @(
    "# Generated by oshal-install.ps1 $(Get-Date -Format s) - operator-local, never commit."
    "OSHAL_REGISTRY=$Registry"
    "OSHAL_IMAGE_TAG=$Tag"
    "OSHAL_PACKAGE_AUDIT_MODE=$PackageAuditMode"
    "POSTGRES_PASSWORD=$(Rand48)"
    "SWARM_SERVICE_SECRET=$(Rand48)"
    "SESSION_SECRET=$(Rand48)"
    "REMOTE_CLIENT_SHARED_SECRET=$(Rand48)"
    "MOCK_OIDC=true"
    "REJECT_LOOP_TICKETS=true"
  )
  if ($BundleProfiles[$Bundle]) { $lines += "COMPOSE_PROFILES=$($BundleProfiles[$Bundle])" }
  $lines += "#"
  $lines += "# -- AI ENGINE --"
  if ($NoAi) {
    $lines += "# -NoAi was passed: this box deliberately runs without a connected model."
    $lines += "# Chat, Jarvis, and manifest-declared AI routes return 503 ai_disabled until enabled."
    $lines += "OSHAL_NO_AI=true"
    $lines += "FORCE_LLM_PROVIDER=noop"
  } else {
    $lines += "CLAUDE_AUTH_MOUNT_MODE=rw"
    $lines += "GEMINI_AUTH_MOUNT_MODE=rw"
  }
  $lines += "#"
  $lines += "# -- WHO YOU ARE --"
  $lines += "# MOCK_OIDC=true has no sign-in page: it treats every request as already logged in as"
  $lines += "# the identity below. Set these to yourself so your accounts, tickets and connector"
  $lines += "# tokens are keyed to YOU. Changing them later = a different user (a fresh, empty"
  $lines += "# workspace). For a real IdP instead: set OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET"
  $lines += "# and remove MOCK_OIDC, then list your real login email below."
  if ($AdminEmail) {
    $lines += "MOCK_OIDC_EMAIL=$AdminEmail"
    $lines += "MOCK_OIDC_NAME=$($AdminEmail.Split('@')[0])"
    $lines += "MOCK_OIDC_SUB=$(LocalSub $AdminEmail)"
    $lines += "# -- SUPERADMIN -- this email is the swarm operator."
    $lines += "OSHAL_OPERATOR_EMAILS=$AdminEmail"
  } else {
    $lines += "# You skipped the email prompt, so you are signed in as the shared demo identity"
    $lines += "# (alex@demo.local). Fill these in and restart the api to become yourself:"
    $lines += "#   docker compose -f compose.dist.yml restart oshal-api"
    $lines += "#MOCK_OIDC_EMAIL=you@example.com"
    $lines += "#MOCK_OIDC_NAME=You"
    $lines += "#MOCK_OIDC_SUB=local-your-stable-id"
    $lines += "#OSHAL_OPERATOR_EMAILS=you@example.com"
  }
  $lines | Out-File -FilePath $envFile -Encoding utf8
} else { Note ".env already exists - keeping yours" }

# -- Stage store packages BEFORE the api boots (auto-load registers each once) -
if ($pkgSet.Count -gt 0) {
  Say "staging $($pkgSet.Count) store package(s): $($pkgSet -join ', ')"
  $storeRepo = 'https://github.com/emeraldcoastsystemsgroup/oshal-apps'
  $storeToken = if ($env:OSHAL_STORE_TOKEN) { $env:OSHAL_STORE_TOKEN } else { $env:GITHUB_TOKEN }
  $installEnv = @('-e', "OSHAL_PACKAGE_AUDIT_MODE=$PackageAuditMode")
  if ($storeToken) {
    $env:OSHAL_STORE_TOKEN = $storeToken
    $installEnv += @('-e', 'OSHAL_STORE_TOKEN')
  }
  foreach ($p in $pkgSet) {
    docker run --rm -v oshal-local_oshal_workspace:/ws alpine:3 sh -c "[ -d /ws/deployed-apps/$p ]" *> $null
    if ($LASTEXITCODE -eq 0) {
      if ($PackageAuditMode -eq 'compatible') { Note "SKIP $p - already installed (never register a bot/surface twice)"; continue }
      Note "$p is already installed; enforce mode revalidates and replaces it from the audited SHA"
    }
    docker run --rm @installEnv -v oshal-local_oshal_workspace:/ws $Image `
      node /app/scripts/oshal-app.js install $p `
      --repo $storeRepo --ref main --dest /ws/deployed-apps --audit-mode $PackageAuditMode
    if ($LASTEXITCODE -ne 0) { throw "package audit/install failed for $p; nothing was activated" }
    Note "staged $p"
  }
}

# -- Ordered, batched bring-up -----------------------------------------------
$compose = Join-Path $Dir 'compose.dist.yml'
function DC { docker compose -f $compose --project-directory $Dir @args }
function WaitHealthy([string]$ctr, [int]$timeoutSec) {
  for ($i = 0; $i -lt [int]($timeoutSec / 3); $i++) {
    $s = docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $ctr 2>$null
    if ($s -eq 'healthy') { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

Say "[1/3] infra (db, redis, chroma)"
DC up -d oshal-db oshal-redis oshal-chromadb
foreach ($c in 'oshal-local-db','oshal-local-redis','oshal-local-chromadb') {
  if (-not (WaitHealthy $c 180)) { throw "$c never went healthy" }
}

Say "[2/3] api - must be FULLY up before bots (auto-loads the staged packages)"
DC up -d --no-deps oshal-api
if (-not (WaitHealthy 'oshal-local-api' 240)) { throw "api never went healthy" }
for ($i = 0; $i -lt 50; $i++) {
  $logs = docker logs oshal-local-api 2>&1 | Out-String
  if ($logs -match 'Swarm app auto-load complete') { break }
  Start-Sleep -Seconds 3
}

Say "[3/3] bots - batched (a mass cold-start OOMs small engines)"
if ($BundleServices[$Bundle] -contains '__ALL__') {
  $remaining = (DC config --services) | Where-Object { $_ -notin 'oshal-db','oshal-redis','oshal-chromadb','oshal-api' }
} else {
  $remaining = @($KernelServices + $BundleServices[$Bundle]) | Where-Object { $_ -and $_ -ne 'oshal-api' } | Select-Object -Unique
}
$batchSize = 5; if ($env:OSHAL_UP_BATCH_SIZE) { $batchSize = [int]$env:OSHAL_UP_BATCH_SIZE }
$settle = 18;   if ($env:OSHAL_UP_BATCH_SETTLE) { $settle = [int]$env:OSHAL_UP_BATCH_SETTLE }
$started = 0; $batch = @()
foreach ($svc in $remaining) {
  $batch += $svc
  if ($batch.Count -ge $batchSize) {
    DC up -d --no-deps @batch | Out-Null
    $started += $batch.Count; Note "started $started/$($remaining.Count)"
    $batch = @()
    if ($started -lt $remaining.Count) { Start-Sleep -Seconds $settle }
  }
}
if ($batch.Count -gt 0) { DC up -d --no-deps @batch | Out-Null; $started += $batch.Count; Note "started $started/$($remaining.Count)" }

# -- Canonical postflight (the same oshal-verify.sh used by the Bash installer) --
# PowerShell remains native: Docker executes the shipped POSIX verifier inside the already-pulled
# image. Container health was checked above, so --skip-containers avoids exposing the host socket;
# readiness and app smokes still cross the real host HTTP boundary.
Say "postflight - capabilities and package smokes"
$verifyArgs = @(
  'run', '--rm', '--env-file', $envFile, $Image,
  'bash', '/app/scripts/oshal-verify.sh', '--skip-containers', '--pre-onboarding',
  '--api', 'http://host.docker.internal:35457'
)
if ($NoAi) { $verifyArgs += '--no-ai' }
if ($pkgSet.Count -gt 0) {
  $verifyArgs += @('--apps', (@($pkgSet) -join ','))
}
& docker @verifyArgs
if ($LASTEXITCODE -ne 0) {
  throw "postflight verification failed - fix the named capability/app and rerun the installer"
}

# -- Show the swarm ----------------------------------------------------------
# Open the WIZARD, not the cockpit. Connecting an AI model is mandatory and is a browser OAuth /
# paste-a-key flow, so it cannot happen out here in PowerShell - the wizard is where linking
# actually lives. (/cockpit would 302 here anyway while onboarding is incomplete; landing on the
# wizard directly is the honest version of the same redirect.)
$welcome = if ($NoAi) { 'http://localhost:35457/cockpit/' } else { 'http://localhost:35457/welcome' }
Say "installed - opening your swarm"
Note "setup:   $welcome"
Note "cockpit: http://localhost:35457/cockpit/   (after setup)"
Start-Process $welcome

Say "what happens next, in the browser"
if ($AdminEmail) {
  Note "You are $AdminEmail - your local login AND the swarm superadmin. No sign-in page will"
  Note "appear: MOCK_OIDC trusts this machine, and .env says that machine is you."
} else {
  Note "You skipped the email prompt, so you are the shared demo identity (alex@demo.local) and"
  Note "NOT the superadmin. To become yourself, set MOCK_OIDC_EMAIL / MOCK_OIDC_NAME /"
  Note "MOCK_OIDC_SUB / OSHAL_OPERATOR_EMAILS in $envFile, then:"
  Note "  docker compose -f `"$compose`" restart oshal-api"
}
if ($NoAi) {
  Note "This box was installed -NoAi. Chat, Jarvis, and app AI routes stay honestly disabled."
  Note "To enable them, remove OSHAL_NO_AI/FORCE_LLM_PROVIDER from $envFile, restart the api,"
  Note "then complete /welcome."
} else {
  Note "1. Connect an AI model - REQUIRED, and the wizard will not let you past it. Free shared"
  Note "   model is one click; an API key or a Claude/Codex login also work."
  Note "2. Connect your accounts (optional) - Gmail, social, storage. Each one is its own consent."
}
Note "Already logged into a vendor CLI on this machine? ~/.claude, ~/.codex and ~/.gemini mount"
Note "read-only into the bots, so that login is reused as-is (BYOK). See INSTALL.md."
