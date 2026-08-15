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
    .\scripts\oshal-install.ps1 -Kubernetes -AdminEmail you@example.com   # helm install onto a cluster
    .\scripts\oshal-install.ps1 -Kubernetes -Yes                          # unattended: install prereqs + cluster

  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - native PowerShell port of scripts/oshal-install.sh (registry mode + bundles + dedup + superadmin + cockpit-open), plus -FromArchive: install from an offline swarm-snapshot tarball (docker load) with zero registry/network dependency. Bundles mirror the bash installer exactly; keep the two in lockstep.
  2 | maintainer@emeraldcoastsystemsgroup.com   | First-run fix - the install never asked WHO the user is, and the closing instructions were false. MOCK_OIDC has no sign-in page; it fabricates alex@demo.local / mock-user-001 and treats every request as authenticated, so "sign in at the cockpit with your email" could never happen and the user was silently someone else - not the superadmin, with every connector token binding to the shared demo sub. Now prompts for the email up front (skippable, interactive hosts only) and writes MOCK_OIDC_EMAIL/NAME/SUB alongside OSHAL_OPERATOR_EMAILS, with the sub derived as a stable hash of the email so a reinstall against the same workspace volume keeps its sub-keyed data. Also opens /welcome rather than /cockpit/ (linking an AI model is mandatory and browser-only - the cockpit just 302s to the wizard anyway) and states plainly what the wizard will ask for.
  3 | maintainer@emeraldcoastsystemsgroup.com   | CORE-05: add the explicit -NoAi posture and invoke the exact shipped oshal-verify.sh inside the image, including every deduplicated app smoke, after native Windows health checks.
  4 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: route package staging through the core installer so invalid audit bindings fail and enforce mode replaces packages from the exact audited SHA.
  5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-129: -Kubernetes — the codeless k8s install, lockstep with oshal-install.sh mode 4. kubectl/helm preflight (winget offers for both), cluster reachability check with crisp Docker-Desktop/kind guidance, chart from the published OCI package with a repo-fetch fallback, fleet presets kernel|full, the same AdminEmail→MOCK_OIDC identity wiring as the compose path (shared LocalSub, hoisted above the branch), NodePort exposure, /api/health postflight, /welcome open. New params: -Namespace, -K8sContext, -NodePort, -Chart, -Fleet.
  6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-129 amendment: bundles/-Apps reach Kubernetes. The k8s branch moves BELOW bundle resolution so it installs the same curated app sets as compose (chart `packages:` staging + the fleet those bots need), auto-creating the private-store Secret when a token is present. Fixes a latent parameter bug found dry-running the new path: `-Apps a,b` is an ARRAY to PowerShell, so the [string] parameter threw a transformation error on the very syntax the bash installer and our closing instructions advertise — now [string[]], accepting both forms.
  7 | maintainer@emeraldcoastsystemsgroup.com   | The k8s path INSTALLS its prerequisites instead of printing links and exiting (operator: the installer should include the prereqs). kubectl/Helm/kind/Docker Desktop are offered via winget, and the session PATH is re-read from the registry after each install so the run CONTINUES rather than demanding a new terminal. With no cluster reachable it stands up a kind cluster with the cockpit port mapped — Docker Desktop's Kubernetes toggle is a GUI setting we deliberately do not poke at, and kind gives the same result scriptably on the engine already installed; it still refuses to create one beside a running compose swarm. New -Yes accepts every prerequisite step for unattended installs, and a non-interactive host DECLINES rather than surprise-installing.
#>
[CmdletBinding()]
param(
  [string]$Bundle = "full",
  # [string[]], not [string]: PowerShell parses `-Apps a,b` as an ARRAY, so a
  # [string] parameter threw a transformation error on the exact comma syntax the
  # bash installer and our own closing instructions use. Accepts both forms.
  [string[]]$Apps = @(),
  [string]$Dir = ".\oshal",
  [string]$Tag = "latest",
  [string]$Registry = "ghcr.io/emeraldcoastsystemsgroup",
  [string]$AdminEmail = "",
  [string]$FromArchive = "",
  [string]$PackageAuditMode = "",
  [switch]$NoAi,
  [switch]$DryRun,
  [switch]$Kubernetes,
  # Accept prerequisite installs (kubectl/Helm/kind/Docker Desktop) without prompting.
  [switch]$Yes,
  [string]$Namespace = "oshal",
  [string]$K8sContext = "",
  [int]$NodePort = 30500,
  [string]$Chart = "",
  [ValidateSet('kernel', 'full')][string]$Fleet = "kernel"
)
$ErrorActionPreference = 'Stop'
if (-not $PackageAuditMode) { $PackageAuditMode = if ($env:OSHAL_PACKAGE_AUDIT_MODE) { $env:OSHAL_PACKAGE_AUDIT_MODE } else { 'compatible' } }
$PackageAuditMode = $PackageAuditMode.Trim().ToLowerInvariant()
if ($PackageAuditMode -notin @('compatible', 'enforce')) { throw "PackageAuditMode must be compatible or enforce" }

function Say([string]$m)  { Write-Host "`n== $m" -ForegroundColor Cyan }
function Note([string]$m) { Write-Host "   $m" }

# Stable local identity derived from the email, so a reinstall against the same workspace volume
# keeps the same user sub (connector tokens and tickets are sub-keyed - a fresh random sub would
# orphan them). Deterministic hash, not a GUID, for exactly that reason. Byte-identical to
# local_sub() in oshal-install.sh; hoisted here because BOTH the compose (.env) and Kubernetes
# (helm values) paths derive the identity from it.
function LocalSub([string]$email) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($email.ToLower()))
    $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    return 'local-' + $hex.Substring(0, 16)
  } finally { $sha.Dispose() }
}


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

# -- -Kubernetes: codeless helm install (ADR-129, lockstep with oshal-install.sh mode 4) --
# Runs BEFORE the Docker gate: a remote cluster needs no local Docker at all. Bundles
# and -Apps are resolved above, so k8s installs the same curated app sets as compose.
if ($Kubernetes) {
  Say "Kubernetes install (helm + registry images - no source, no build)"
  $winget = Get-Command winget -ErrorAction SilentlyContinue

  # winget writes PATH to the registry, not to this process. Re-read it so the
  # install can CONTINUE instead of telling the user to open a new terminal.
  function Update-SessionPath {
    $env:PATH = ([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'
  }
  function Confirm-Step([string]$prompt) {
    if ($Yes) { return $true }
    if (-not [Environment]::UserInteractive) { return $false }  # never surprise-install
    $a = Read-Host "   $prompt [Y/n]"
    return ($a -eq '' -or $a -match '^[Yy]')
  }
  function Install-Tool([string]$label, [string]$id, [string]$exe, [string]$manualUrl) {
    if (Get-Command $exe -ErrorAction SilentlyContinue) { return $true }
    Say "$label is not installed"
    if (-not $winget) { Note "winget is unavailable - install $label manually: $manualUrl"; return $false }
    if (-not (Confirm-Step "install $label now via winget?")) { Note "Install $label yourself: $manualUrl"; return $false }
    winget install --id $id --accept-source-agreements --accept-package-agreements --silent
    Update-SessionPath
    if (Get-Command $exe -ErrorAction SilentlyContinue) { Note "$label installed"; return $true }
    Note "$label installed but not on PATH yet - open a NEW terminal and re-run this installer."
    return $false
  }

  if (-not (Install-Tool 'kubectl' 'Kubernetes.kubectl' 'kubectl' 'https://kubernetes.io/docs/tasks/tools/')) { exit 1 }
  if (-not (Install-Tool 'Helm' 'Helm.Helm' 'helm' 'https://helm.sh/docs/intro/install/')) { exit 1 }

  $kcArgs = @(); $helmCtx = @()
  if ($K8sContext) { $kcArgs = @('--context', $K8sContext); $helmCtx = @('--kube-context', $K8sContext) }

  kubectl @kcArgs cluster-info *> $null
  if ($LASTEXITCODE -ne 0) {
    Say "no reachable Kubernetes cluster$(if ($K8sContext) { " (context $K8sContext)" })"
    if ($K8sContext) {
      Note "Context '$K8sContext' does not reach a cluster. Fix it, or drop -K8sContext and let the"
      Note "installer stand a local cluster up."
      exit 1
    }

    # Docker Desktop's Kubernetes toggle is a GUI setting we should not poke at.
    # kind gives the same thing scriptably, on the Docker engine that is already there.
    $dockerOk = $false
    if (Get-Command docker -ErrorAction SilentlyContinue) { docker info *> $null; $dockerOk = ($LASTEXITCODE -eq 0) }
    if (-not $dockerOk) {
      Say "Docker is not running"
      if (Install-Tool 'Docker Desktop' 'Docker.DockerDesktop' 'docker' 'https://docs.docker.com/get-docker/') {
        Note "Docker Desktop installed. START IT once (it finishes setup on first launch), then re-run."
      }
      exit 1
    }

    # NEVER kind + the compose swarm on one machine (OOM-wedges the engine, twice proven).
    $swarmUp = (docker ps --format '{{.Names}}' 2>$null) -contains 'oshal-local-api'
    if ($swarmUp) {
      Note "The compose swarm is RUNNING on this machine. Refusing to create a kind cluster beside it -"
      Note "that pairing OOM-wedges the shared Docker engine. Use another computer, or stop the swarm."
      exit 1
    }

    if (-not (Install-Tool 'kind' 'Kubernetes.kind' 'kind' 'https://kind.sigs.k8s.io')) {
      Note "Alternative: Docker Desktop -> Settings -> Kubernetes -> Enable Kubernetes, then re-run."
      exit 1
    }
    if (-not (Confirm-Step 'create a local kind cluster "oshal" (single node, cockpit port mapped)?')) {
      Note "Nothing installed. Enable Docker Desktop's Kubernetes, or allow kind, then re-run."
      exit 1
    }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $kindCfg = Join-Path $Dir 'kind-oshal.yaml'
    @"
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: $NodePort
        hostPort: $NodePort
"@ | Out-File -FilePath $kindCfg -Encoding utf8
    kind create cluster --name oshal --config $kindCfg
    if ($LASTEXITCODE -ne 0) { throw "kind cluster creation failed" }
    $kcArgs = @('--context', 'kind-oshal'); $helmCtx = @('--kube-context', 'kind-oshal')
  }

  # An app bundle brings the fleet its bots need — a bundle whose bots never start
  # is an app that cannot run. -Fleet still wins when the caller names it.
  if (-not $PSBoundParameters.ContainsKey('Fleet') -and $Bundle -ne 'kernel') { $Fleet = 'full' }

  if ($DryRun) {
    Say "DRY RUN"
    Note "mode      : kubernetes (helm)"
    Note "namespace : $Namespace   context: $(if ($K8sContext) { $K8sContext } else { 'current' })"
    Note "nodeport  : $NodePort   fleet: $Fleet   tag: $Tag"
    Note "bundle    : $Bundle   packages: $(if ($pkgSet.Count) { $pkgSet -join ', ' } else { '(none)' })"
    Note "chart     : $(if ($Chart) { $Chart } else { 'published OCI package, repo fallback' })"
    exit 0
  }

  # Chart source: explicit -Chart, else the published OCI chart, else the chart files
  # fetched from the repo (still no source build - the fallback exists so a fresh box
  # works even before the operator's first chart publish).
  $ociRef = "oci://$Registry/charts/oshal"
  $chartSrc = $Chart
  if (-not $chartSrc) {
    helm show chart $ociRef *> $null
    if ($LASTEXITCODE -eq 0) { $chartSrc = $ociRef }
    else {
      Note "OCI chart not published yet at $ociRef - fetching the chart from the repo"
      $chartDir = Join-Path $Dir 'chart-src'
      New-Item -ItemType Directory -Force -Path $chartDir | Out-Null
      $tgz = Join-Path $chartDir 'repo.tgz'
      Invoke-WebRequest -UseBasicParsing -Uri 'https://codeload.github.com/emeraldcoastsystemsgroup/oshal/tar.gz/refs/heads/main' -OutFile $tgz
      tar -xzf $tgz -C $chartDir --strip-components=4 'oshal-main/deploy/helm/oshal'
      if ($LASTEXITCODE -ne 0) { throw "could not extract the chart - pass -Chart <dir> to use a local chart" }
      Remove-Item $tgz -Force
      $chartSrc = $chartDir
    }
  }

  # Who owns this swarm? Same question, same reason as the compose path: MOCK_OIDC has
  # no sign-in page, so this identity IS the login.
  if (-not $AdminEmail -and [Environment]::UserInteractive) {
    Say "who owns this swarm?"
    Note "Your email becomes your local login AND makes you the superadmin. It is written only"
    Note "into the cluster's api env. Press Enter to skip (shared demo identity)."
    $AdminEmail = (Read-Host "   your email").Trim()
  }

  $helmSet = @(
    '--set-string', "image.repository=$Registry/oshal-bot",
    '--set-string', "image.tag=$Tag",
    '--set', 'api.service.type=NodePort',
    '--set', "api.service.nodePort=$NodePort",
    '--set-string', "fleet=$Fleet",
    '--set-string', "store.auditMode=$PackageAuditMode"
  )
  # Store packages: the chart stages these into the workspace PVC before the api
  # boots (auto-load registers each package's bots and surfaces once, at boot).
  if ($pkgSet.Count -gt 0) {
    $helmSet += @('--set', "packages={$($pkgSet -join ',')}")
    Note "packages to stage: $($pkgSet -join ', ')"
    $storeToken = if ($env:OSHAL_STORE_TOKEN) { $env:OSHAL_STORE_TOKEN } else { $env:GITHUB_TOKEN }
    if ($storeToken) {
      # Private store repos only; the chart reads the Secret optionally.
      kubectl @kcArgs create namespace $Namespace *> $null
      kubectl @kcArgs -n $Namespace create secret generic oshal-store `
        --from-literal="OSHAL_STORE_TOKEN=$storeToken" --dry-run=client -o yaml |
        kubectl @kcArgs apply -f - *> $null
      $helmSet += @('--set-string', 'store.tokenSecret=oshal-store')
      Note "private-store token wired (Secret oshal-store)"
    }
  }
  if ($AdminEmail) {
    $helmSet += @(
      '--set-string', "api.extraEnv.MOCK_OIDC_EMAIL=$AdminEmail",
      '--set-string', "api.extraEnv.MOCK_OIDC_NAME=$($AdminEmail.Split('@')[0])",
      '--set-string', "api.extraEnv.MOCK_OIDC_SUB=$(LocalSub $AdminEmail)",
      '--set-string', "api.extraEnv.OSHAL_OPERATOR_EMAILS=$AdminEmail"
    )
  }
  if ($NoAi) {
    $helmSet += @('--set-string', 'swarm.forceLlmProvider=noop', '--set-string', 'swarm.forceLlmModel=',
                  '--set-string', 'api.extraEnv.OSHAL_NO_AI=true')
  }

  Say "installing chart into namespace $Namespace (first image pull is a few GB - one-time)"
  helm @helmCtx upgrade --install oshal $chartSrc --namespace $Namespace --create-namespace --wait --timeout 20m @helmSet
  if ($LASTEXITCODE -ne 0) {
    throw "helm install failed - the messages above name the broken leg. Cleanup if needed: helm uninstall oshal -n $Namespace"
  }

  # Where the cockpit lives: localhost for desktop cluster shapes, the first node's
  # InternalIP otherwise (k3s/server installs).
  $ctxName = $K8sContext
  if (-not $ctxName) { try { $ctxName = (& kubectl config current-context 2>$null) } catch { $ctxName = '' } }
  $hostAddr = 'localhost'
  if ($ctxName -notmatch '^(docker-desktop$|kind-|k3d-|minikube$)') {
    try {
      $ip = (& kubectl @kcArgs get nodes -o "jsonpath={.items[0].status.addresses[?(@.type=='InternalIP')].address}" 2>$null)
      if ($ip) { $hostAddr = $ip }
    } catch {}
  }
  $base = "http://${hostAddr}:$NodePort"

  Say "postflight: waiting for the api to answer"
  $apiOk = $false
  foreach ($i in 1..50) {
    try { Invoke-WebRequest -UseBasicParsing -Uri "$base/api/health" -TimeoutSec 5 *> $null; $apiOk = $true; break }
    catch { Start-Sleep -Seconds 3 }
  }
  if (-not $apiOk) {
    Note "WARNING: $base/api/health not answering. Pods:"
    kubectl @kcArgs -n $Namespace get pods
    Note "A pre-existing kind cluster without a port mapping cannot expose NodePorts to this host -"
    Note "durable access: kubectl -n $Namespace port-forward svc/oshal-api ${NodePort}:5000"
  } else {
    Note "api healthy - $base   (fleet: $Fleet)"
  }

  $welcome = "$base/welcome"; if ($NoAi) { $welcome = "$base/cockpit/" }
  Say "installed - opening your swarm"
  Note "setup:   $welcome"
  Note "cockpit: $base/cockpit/   (after setup)"
  Start-Process $welcome *> $null

  Say "what happens next, in the browser"
  if ($AdminEmail) {
    Note "You are $AdminEmail - your local login AND the swarm superadmin."
  } else {
    Note "You skipped the email prompt, so you are the shared demo identity (alex@demo.local). To"
    Note "become yourself later, re-run with -AdminEmail you@example.com - helm upgrades in place."
  }
  if ($NoAi) {
    Note "This cluster was installed -NoAi: AI features stay disabled until a model is connected."
  } else {
    Note "1. Connect an AI model - REQUIRED. The wizard offers the free shared model, an API key,"
    Note "   or a hosted login. (k8s has NO vendor-CLI OAuth mounts - the wizard IS the path; fleet"
    Note "   API keys can also live in an oshal-bot-env Secret, see deploy/helm/oshal/README.md.)"
    Note "2. Connect your accounts (optional) - each one is its own consent."
  }
  Note "More apps any time: cockpit -> Explore Apps, or re-run with -Apps name1,name2"
  Note "(helm upgrades in place; the chart stages new packages before the api restarts)."
  Note "Uninstall: helm uninstall oshal -n $Namespace ; kubectl delete ns $Namespace"
  exit 0
}

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
# (LocalSub - the stable email-derived identity - is defined up top, shared with -Kubernetes.)

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
