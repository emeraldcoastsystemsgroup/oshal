<#
  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Shared helpers for the Windows one-click installer: preflight probes, .env upsert, join-code codec, Docker host-path translation, health polling.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Added system-facts doctor (RAM/disk/cores/ports), Headscale detection + preauth-key minting, and join-code v2 (carries the tailnet login server + authkey for off-LAN nodes).
  3 | maintainer@emeraldcoastsystemsgroup.com   | Doctor now checks the operator allowlist: isOperator() is fail-closed, so an empty OSHAL_OPERATOR_EMAILS locks everyone out of /api/join and the Security Center on a fresh install.

  installer/lib/common.ps1 -- dot-sourced by install-swarm.ps1 and install-node.ps1.

  Everything here is pure ASCII and PowerShell 5.1 compatible (no ternary, no ??,
  no && chaining) because it runs on a stock Windows box before anything is set up.
#>

# No Set-StrictMode here on purpose: this file is dot-sourced, and strictness would
# leak into the caller's session. Each entry-point script sets its own.

# ---------------------------------------------------------------------------
# Console output. The GUI parses these prefixes to colorize the log pane, and
# scrapes the RESULT: lines to populate the success screen.
# ---------------------------------------------------------------------------

function Write-Step { param([string]$Message) Write-Host ""; Write-Host "== $Message" }
function Write-Ok   { param([string]$Message) Write-Host "[ok] $Message" }
function Write-Info { param([string]$Message) Write-Host "     $Message" }
function Write-Warn { param([string]$Message) Write-Host "[!]  $Message" }
function Write-Fail { param([string]$Message) Write-Host "[x]  $Message" }

<#
.SYNOPSIS Emits a machine-readable key/value the GUI scrapes off stdout.
.DESCRIPTION The child install scripts are plain console scripts so power users can
run them from a terminal. The GUI runs them as a subprocess and needs a couple of
values back (cockpit URL, join code). Rather than a temp file, they are printed on
stdout behind a marker the GUI greps for and the human reader ignores.
.PARAMETER Key Marker name, e.g. JOINCODE.
.PARAMETER Value The value to hand back.
#>
function Write-Result {
    param([Parameter(Mandatory)][string]$Key, [Parameter(Mandatory)][string]$Value)
    Write-Host "RESULT:${Key}=${Value}"
}

<#
.SYNOPSIS Writes the failure and terminates the script with a non-zero exit code.
.PARAMETER Message What went wrong.
.PARAMETER Hint    The single next action the operator should take.
#>
function Stop-WithError {
    param([Parameter(Mandatory)][string]$Message, [string]$Hint = '')
    Write-Fail $Message
    if ($Hint) { Write-Info $Hint }
    exit 1
}

# ---------------------------------------------------------------------------
# Environment probes
# ---------------------------------------------------------------------------

<#
.SYNOPSIS True when the named executable resolves on PATH.
.PARAMETER Name Executable name, e.g. docker.
.OUTPUTS [bool]
#>
function Test-CommandExists {
    param([Parameter(Mandatory)][string]$Name)
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    return ($null -ne $found)
}

<#
.SYNOPSIS True when the current process holds the local Administrators role.
.DESCRIPTION Firewall rules and some winget installs need elevation. The installer
degrades gracefully rather than demanding it up front, so this is a probe, not a gate.
.OUTPUTS [bool]
#>
function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
.SYNOPSIS Installs a package via winget, returning success as a bool rather than throwing.
.DESCRIPTION Used for the two prerequisites a clean Windows box is missing: Docker
Desktop (swarm role) and Node.js LTS (node role). Failure is recoverable -- the caller
falls back to telling the human which URL to open.
.PARAMETER PackageId The winget package identifier, e.g. OpenJS.NodeJS.LTS.
.OUTPUTS [bool] True when winget reported success.
#>
function Install-WingetPackage {
    param([Parameter(Mandatory)][string]$PackageId)
    if (-not (Test-CommandExists 'winget')) {
        Write-Warn "winget is not available on this machine."
        return $false
    }
    Write-Info "winget install --id $PackageId (this can take several minutes)"
    winget install --exact --id $PackageId --accept-package-agreements --accept-source-agreements --silent
    return ($LASTEXITCODE -eq 0)
}

<#
.SYNOPSIS Scores an IPv4 address by how likely it is to be the machine's real LAN address.
.DESCRIPTION Lower is better. Ordinary private ranges beat 100.64.0.0/10, which is CGNAT and
in practice means a Tailscale/Headscale tailnet adapter. A tailnet address is only reachable
from other tailnet members, so handing it to a neighbour on the same Wi-Fi produces a join
code that silently never connects.
.PARAMETER Address A dotted-quad.
.OUTPUTS [int] 0 = home LAN, 1 = other private, 2 = tailnet/CGNAT, 3 = anything else.
#>
function Get-LanAddressRank {
    param([Parameter(Mandatory)][string]$Address)
    if ($Address -like '192.168.*') { return 0 }
    if ($Address -match '^172\.(1[6-9]|2[0-9]|3[01])\.') { return 1 }
    if ($Address -like '10.*') { return 1 }
    if ($Address -match '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.') { return 2 }
    return 3
}

<#
.SYNOPSIS Best-effort LAN IPv4 for this machine, excluding loopback, APIPA and virtual adapters.
.DESCRIPTION The join code embeds a URL that a *different* machine has to reach, so localhost is
useless. Docker/WSL vEthernet adapters are filtered out (not routable off-box), and candidates
are ranked so a real LAN address wins over a tailnet one before interface metric breaks ties.
.OUTPUTS [string] A dotted-quad, or empty string when nothing suitable was found.
#>
function Get-LanIPv4 {
    $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.IPAddress -notlike '169.254.*' -and
            $_.InterfaceAlias -notlike 'vEthernet*' -and
            $_.InterfaceAlias -notlike '*Loopback*'
        } |
        Sort-Object -Property @{ Expression = { Get-LanAddressRank -Address $_.IPAddress } },
                              @{ Expression = { $_.InterfaceMetric } }
    if (-not $candidates) { return '' }
    return @($candidates)[0].IPAddress
}

<#
.SYNOPSIS Translates a Windows path into the path Docker Desktop sees inside its VM.
.DESCRIPTION docker-compose.oshal-local.yml passes COMPOSE_PROJECT_ROOT to the API so it
can insert bot containers dynamically. Inside Docker Desktop's Linux VM the host C: drive
is bind-mounted at /run/desktop/mnt/host/c. Without this the install only works from the
one hardcoded path the compose file defaults to.
.PARAMETER Path A Windows path, e.g. C:\Projects\openswarm.
.OUTPUTS [string] e.g. /run/desktop/mnt/host/c/Projects/openswarm
#>
function ConvertTo-DockerHostPath {
    param([Parameter(Mandatory)][string]$Path)
    $full = (Resolve-Path -LiteralPath $Path).Path
    $drive = $full.Substring(0, 1).ToLowerInvariant()
    $rest = $full.Substring(2).Replace('\', '/')
    return "/run/desktop/mnt/host/$drive$rest"
}

# ---------------------------------------------------------------------------
# Join code -- the single string a human carries from the swarm box to a node box.
# Format: OSJOIN1.<base64url("<controlPlaneUrl>|<sharedSecret>")>
# ---------------------------------------------------------------------------

<#
.SYNOPSIS Mints a cryptographically random shared secret for remote-client auth.
.DESCRIPTION Becomes REMOTE_CLIENT_SHARED_SECRET on the controller and the bearer a
joining node presents. 32 bytes of CSPRNG output, base64url so it survives copy/paste
out of a console and into a text box.
.OUTPUTS [string] A 43-character base64url secret.
#>
function New-JoinSecret {
    $bytes = New-Object 'byte[]' 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return (ConvertTo-Base64Url -Bytes $bytes)
}

<#
.SYNOPSIS Base64url-encodes bytes (RFC 4648 section 5, padding stripped).
.PARAMETER Bytes Raw input.
.OUTPUTS [string]
#>
function ConvertTo-Base64Url {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $b64 = [Convert]::ToBase64String($Bytes)
    return $b64.Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

<#
.SYNOPSIS Decodes a base64url string back to bytes, restoring the stripped padding.
.PARAMETER Text A base64url string.
.OUTPUTS [byte[]]
#>
function ConvertFrom-Base64Url {
    param([Parameter(Mandatory)][string]$Text)
    $b64 = $Text.Replace('-', '+').Replace('_', '/')
    switch ($b64.Length % 4) {
        2 { $b64 = $b64 + '==' }
        3 { $b64 = $b64 + '=' }
    }
    return [Convert]::FromBase64String($b64)
}

<#
.SYNOPSIS Packs everything a node needs to join into one pasteable token.
.DESCRIPTION Emits v1 (`OSJOIN1.<b64url("url|secret")>`) when the swarm is only reachable on
the LAN, and v2 (`OSJOIN2.<b64url(json)>`) when it also carries tailnet credentials so a node
somewhere else can dial in. v1 stays the default so existing codes and docs keep working.
.PARAMETER ControlPlaneUrl  Where the joining node reaches the controller.
.PARAMETER SharedSecret     The controller's REMOTE_CLIENT_SHARED_SECRET.
.PARAMETER HeadscaleUrl     Optional tailnet login server, e.g. http://localhost:8085.
.PARAMETER HeadscaleAuthKey Optional Headscale pre-auth key. Requires HeadscaleUrl.
.OUTPUTS [string] OSJOIN1.* or OSJOIN2.*
#>
function ConvertTo-JoinCode {
    param(
        [Parameter(Mandatory)][string]$ControlPlaneUrl,
        [Parameter(Mandatory)][string]$SharedSecret,
        [string]$HeadscaleUrl = '',
        [string]$HeadscaleAuthKey = ''
    )
    if ($HeadscaleUrl -and $HeadscaleAuthKey) {
        $payload = [ordered]@{ u = $ControlPlaneUrl; s = $SharedSecret; h = $HeadscaleUrl; k = $HeadscaleAuthKey }
        $json = ($payload | ConvertTo-Json -Compress)
        return "OSJOIN2." + (ConvertTo-Base64Url -Bytes ([Text.Encoding]::UTF8.GetBytes($json)))
    }
    $raw = "$ControlPlaneUrl|$SharedSecret"
    return "OSJOIN1." + (ConvertTo-Base64Url -Bytes ([Text.Encoding]::UTF8.GetBytes($raw)))
}

<#
.SYNOPSIS Unpacks a v1 or v2 join code, tolerating whitespace from a clipboard round-trip.
.PARAMETER JoinCode The OSJOIN1.* or OSJOIN2.* token.
.OUTPUTS [hashtable] ControlPlaneUrl, SharedSecret, HeadscaleUrl, HeadscaleAuthKey (last two '' for v1).
.NOTES Throws on a malformed token so callers show one clear "that code is not valid" message.
#>
function ConvertFrom-JoinCode {
    param([Parameter(Mandatory)][string]$JoinCode)
    $trimmed = ($JoinCode -replace '\s', '')
    $corrupt = "Join code is corrupt -- copy it again from the swarm machine."

    if ($trimmed.StartsWith('OSJOIN2.')) {
        $json = [Text.Encoding]::UTF8.GetString((ConvertFrom-Base64Url -Text $trimmed.Substring(8)))
        $obj = $json | ConvertFrom-Json
        if (-not $obj.u -or -not $obj.s) { throw $corrupt }
        return @{
            ControlPlaneUrl  = [string]$obj.u
            SharedSecret     = [string]$obj.s
            HeadscaleUrl     = [string]$obj.h
            HeadscaleAuthKey = [string]$obj.k
        }
    }

    if ($trimmed.StartsWith('OSJOIN1.')) {
        $raw = [Text.Encoding]::UTF8.GetString((ConvertFrom-Base64Url -Text $trimmed.Substring(8)))
        $parts = $raw.Split('|')
        if ($parts.Count -ne 2 -or -not $parts[0] -or -not $parts[1]) { throw $corrupt }
        return @{ ControlPlaneUrl = $parts[0]; SharedSecret = $parts[1]; HeadscaleUrl = ''; HeadscaleAuthKey = '' }
    }

    throw "Not an Open Swarm join code (expected it to start with OSJOIN1. or OSJOIN2.)"
}

# ---------------------------------------------------------------------------
# .env upsert -- the controller reads its config from the repo-root .env file.
# ---------------------------------------------------------------------------

<#
.SYNOPSIS Reads a single KEY=value out of a dotenv file.
.PARAMETER Path The .env file.
.PARAMETER Key  The variable name.
.OUTPUTS [string] The value, or empty string when unset or the file is absent.
#>
function Get-EnvFileValue {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Key)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
            return $Matches[1].Trim()
        }
    }
    return ''
}

<#
.SYNOPSIS Inserts or replaces a KEY=value in a dotenv file, preserving every other line.
.DESCRIPTION Written with UTF8 *without* a BOM: docker compose treats a leading BOM as
part of the first variable name, which silently breaks the first setting in the file.
.PARAMETER Path  The .env file (created if absent).
.PARAMETER Key   The variable name.
.PARAMETER Value The value to set.
#>
function Set-EnvFileValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Value
    )
    $lines = @()
    if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path) }

    $pattern = "^\s*$([regex]::Escape($Key))\s*="
    $replaced = $false
    $out = foreach ($line in $lines) {
        if ($line -match $pattern) { $replaced = $true; "$Key=$Value" } else { $line }
    }
    if (-not $replaced) { $out = @($out) + @("$Key=$Value") }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllLines($Path, [string[]]@($out), $utf8NoBom)
}

# ---------------------------------------------------------------------------
# Health polling
# ---------------------------------------------------------------------------

<#
.SYNOPSIS Polls a URL until it answers 200 or the timeout expires.
.PARAMETER Url            The endpoint to poll.
.PARAMETER TimeoutSeconds Give up after this long.
.PARAMETER OnTick         Optional callback invoked once per poll so a caller can show progress.
.OUTPUTS [bool] True when the endpoint answered 200 before the deadline.
#>
function Wait-HttpOk {
    param(
        [Parameter(Mandatory)][string]$Url,
        [int]$TimeoutSeconds = 300,
        [scriptblock]$OnTick = $null
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { return $true }
        } catch {
            # Not up yet. The loop is the retry; nothing to log per-attempt.
        }
        if ($OnTick) { & $OnTick }
        Start-Sleep -Seconds 5
    }
    return $false
}

<#
.SYNOPSIS Fetches a URL and reports whether it answered 200. Never throws.
.PARAMETER Url The endpoint.
.OUTPUTS [bool]
#>
function Test-HttpOk {
    param([Parameter(Mandatory)][string]$Url)
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
        return ($resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------------------
# Doctor: does this machine have enough to run the stack comfortably?
#
# Thresholds come from a measured default install (2026-07-08): 38 containers
# idling at 2.6 GB RSS, ~12 GB of images of which oshal-bot alone is 6.5 GB.
# ---------------------------------------------------------------------------

$script:MinDockerRamGb  = 6
$script:GoodDockerRamGb = 10
$script:MinFreeDiskGb   = 25
$script:GoodFreeDiskGb  = 40
$script:MinCores        = 4

# The identity MOCK_OIDC signs everyone in as (src/shared/middleware/oidc.ts:70).
# The zero-keys install has no real identity provider, so this is who "you" are.
$script:MockOidcEmail = 'alex@demo.local'

<#
.SYNOPSIS Loose check that a string looks like an email address.
.DESCRIPTION Deliberately permissive: the allowlist is matched literally against whatever the
IdP puts in the `email` claim, so the only real failure is a typo the operator can see.
.PARAMETER Address The candidate.
.OUTPUTS [bool]
#>
function Test-EmailLike {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Address)
    return ($Address -match '^[^@\s]+@[^@\s]+\.[^@\s]+$')
}

<#
.SYNOPSIS Reads how much RAM and how many cores the Docker VM was actually given.
.DESCRIPTION Host RAM is the wrong number on Windows and macOS: containers only ever see what
Docker Desktop's VM was allocated. `docker info` reports the VM's view, which is the one that
decides whether the stack swaps.
.OUTPUTS [hashtable] @{ RamGb; Cores } -- zeros when the daemon is unreachable.
#>
function Get-DockerCapacity {
    $raw = docker info --format '{{.MemTotal}}|{{.NCPU}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return @{ RamGb = 0; Cores = 0 } }
    $parts = $raw.Split('|')
    return @{
        RamGb = [math]::Round([double]$parts[0] / 1GB, 1)
        Cores = [int]$parts[1]
    }
}

<#
.SYNOPSIS Free space, in GB, on the volume holding a path.
.PARAMETER Path Any path on the volume of interest.
.OUTPUTS [double] Free GB, or 0 when it cannot be determined.
#>
function Get-FreeDiskGb {
    param([Parameter(Mandatory)][string]$Path)
    $qualifier = (Split-Path -Qualifier (Resolve-Path -LiteralPath $Path).Path).TrimEnd(':')
    $drive = Get-PSDrive -Name $qualifier -ErrorAction SilentlyContinue
    if (-not $drive) { return 0 }
    return [math]::Round($drive.Free / 1GB, 1)
}

<#
.SYNOPSIS True when nothing is already listening on a TCP port.
.PARAMETER Port The port to probe.
.OUTPUTS [bool]
#>
function Test-PortFree {
    param([Parameter(Mandatory)][int]$Port)
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return ($null -eq $listener)
}

<#
.SYNOPSIS Builds one doctor row.
.PARAMETER Label What the operator reads.
.PARAMETER Level 'ok' | 'warn' | 'bad'
.PARAMETER Hint  What to do about it. Empty when nothing to do.
.OUTPUTS [hashtable]
#>
function New-DoctorRow {
    param([string]$Label, [string]$Level, [string]$Hint = '')
    return @{ Label = $Label; Level = $Level; Hint = $Hint }
}

<#
.SYNOPSIS Reads the operator allowlist out of .env.
.PARAMETER RepoRoot Repository root.
.OUTPUTS [string] The raw comma-separated OSHAL_OPERATOR_EMAILS value, or '' when unset.
#>
function Get-OperatorAllowlist {
    param([Parameter(Mandatory)][string]$RepoRoot)
    return (Get-EnvFileValue -Path (Join-Path $RepoRoot '.env') -Key 'OSHAL_OPERATOR_EMAILS')
}

<#
.SYNOPSIS Reports whether anyone can actually administer this swarm.
.DESCRIPTION isOperator() in src/shared/middleware/authz.ts:54 is FAIL-CLOSED -- an empty
allowlist means there are no operators at all. On a fresh install that silently locks everyone
out of the Security Center and of /api/join, the page that mints join codes for new machines.
Nothing in the app says so; you just get a 403. Hence a doctor row.
.PARAMETER RepoRoot Repository root.
.OUTPUTS [hashtable] A doctor row.
#>
function Get-OperatorDoctorRow {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $allowlist = Get-OperatorAllowlist -RepoRoot $RepoRoot
    if ($allowlist) {
        return (New-DoctorRow "Operator: $allowlist" 'ok')
    }
    return (New-DoctorRow 'No operator is set -- nobody could add a computer or open the Security Center' 'warn' `
        'The installer will make you the operator. Enter your email below, or leave it blank for the demo login.')
}

<#
.SYNOPSIS Measures this machine against what a default install actually consumes.
.DESCRIPTION Structured rather than printed, so both the console scripts and the GUI can render
it. Shortfalls are 'bad' but never fatal: a 6 GB Docker VM does run the stack, it just swaps
under a build, and the operator is entitled to make that trade knowingly.
.PARAMETER RepoRoot    Path whose volume must hold the images.
.PARAMETER CockpitPort Port that must be free.
.OUTPUTS [hashtable[]] One row per check.
#>
function Get-DoctorReport {
    param([Parameter(Mandatory)][string]$RepoRoot, [int]$CockpitPort = 35457)
    $rows = @()
    $cap = Get-DockerCapacity
    $rows += Get-OperatorDoctorRow -RepoRoot $RepoRoot

    if ($cap.RamGb -ge $script:GoodDockerRamGb) {
        $rows += New-DoctorRow "Docker has $($cap.RamGb) GB RAM" 'ok'
    } elseif ($cap.RamGb -ge $script:MinDockerRamGb) {
        $rows += New-DoctorRow "Docker has $($cap.RamGb) GB RAM (comfortable is $($script:GoodDockerRamGb))" 'warn' `
            'Raise it in Docker Desktop -> Settings -> Resources.'
    } else {
        $rows += New-DoctorRow "Docker has only $($cap.RamGb) GB RAM (need $($script:MinDockerRamGb))" 'bad' `
            'Raise it in Docker Desktop -> Settings -> Resources, or install without worker bots.'
    }

    if ($cap.Cores -ge $script:MinCores) {
        $rows += New-DoctorRow "Docker has $($cap.Cores) CPU cores" 'ok'
    } else {
        $rows += New-DoctorRow "Docker has $($cap.Cores) CPU cores (want $($script:MinCores))" 'bad' `
            'The image build will be slow.'
    }

    $freeGb = Get-FreeDiskGb -Path $RepoRoot
    if ($freeGb -ge $script:GoodFreeDiskGb) {
        $rows += New-DoctorRow "$freeGb GB free disk" 'ok'
    } elseif ($freeGb -ge $script:MinFreeDiskGb) {
        $rows += New-DoctorRow "$freeGb GB free disk (images are ~12 GB, plus build cache)" 'warn'
    } else {
        $rows += New-DoctorRow "$freeGb GB free disk (need $($script:MinFreeDiskGb) GB; images alone are ~12 GB)" 'bad'
    }

    if (Test-PortFree -Port $CockpitPort) {
        $rows += New-DoctorRow "Port $CockpitPort is free" 'ok'
    } else {
        $rows += New-DoctorRow "Something already listens on port $CockpitPort" 'warn' `
            'If that is an older Open Swarm this install reuses it. Otherwise set OSHAL_API_PORT.'
    }

    return $rows
}

<#
.SYNOPSIS Prints the doctor report to the console.
.PARAMETER RepoRoot    Path whose volume must hold the images.
.PARAMETER CockpitPort Port that must be free.
.OUTPUTS [int] Number of rows below the minimum (0 = all clear).
#>
function Invoke-SystemDoctor {
    param([Parameter(Mandatory)][string]$RepoRoot, [int]$CockpitPort = 35457)
    Write-Step "Checking this machine"
    $rows = Get-DoctorReport -RepoRoot $RepoRoot -CockpitPort $CockpitPort
    foreach ($row in $rows) {
        switch ($row.Level) {
            'ok'   { Write-Ok   $row.Label }
            'warn' { Write-Warn $row.Label }
            'bad'  { Write-Warn $row.Label }
        }
        if ($row.Hint) { Write-Info $row.Hint }
    }
    return @($rows | Where-Object { $_.Level -eq 'bad' }).Count
}

# ---------------------------------------------------------------------------
# Headscale: let a node outside this LAN reach the swarm over a tailnet.
# ---------------------------------------------------------------------------

<#
.SYNOPSIS True when this machine is running the oshal-headscale container.
.OUTPUTS [bool]
#>
function Test-HeadscaleRunning {
    $names = docker ps --filter 'name=oshal-headscale' --format '{{.Names}}' 2>$null
    return ($LASTEXITCODE -eq 0 -and $names -match 'oshal-headscale')
}

<#
.SYNOPSIS Resolves a Headscale username to the numeric id its CLI now requires.
.DESCRIPTION headscale v0.29 changed `preauthkeys create --user` from a name to a uint. Passing
the name fails with a strconv.ParseUint error, which is exactly the bug in scripts/headscale-setup.sh.
.PARAMETER UserName The Headscale user, e.g. agentmesh.
.OUTPUTS [string] The numeric id, or '' when the user does not exist.
#>
function Get-HeadscaleUserId {
    param([Parameter(Mandatory)][string]$UserName)
    $json = docker exec oshal-headscale headscale users list -o json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $json) { return '' }
    $users = $json | ConvertFrom-Json
    foreach ($u in $users) {
        if ($u.name -eq $UserName) { return [string]$u.id }
    }
    return ''
}

<#
.SYNOPSIS Mints a reusable Headscale pre-auth key so a remote node can join the tailnet.
.DESCRIPTION Parses `-o json` rather than scraping stdout with a hex regex: real v0.29 keys are
`hskey-auth-<mixed case, hyphens, underscores>` and the old `[a-f0-9]{48,}` pattern silently
matched nothing, then fell back to using the whole stdout blob as the "key".
.PARAMETER UserName      Headscale user to attach the key to.
.PARAMETER ExpirationHrs How long the key stays valid.
.OUTPUTS [string] The pre-auth key, or '' on failure.
#>
function New-HeadscalePreauthKey {
    param([string]$UserName = 'agentmesh', [int]$ExpirationHrs = 24)

    $userId = Get-HeadscaleUserId -UserName $UserName
    if (-not $userId) {
        docker exec oshal-headscale headscale users create $UserName 2>$null | Out-Null
        $userId = Get-HeadscaleUserId -UserName $UserName
    }
    if (-not $userId) { return '' }

    $json = docker exec oshal-headscale headscale preauthkeys create --user $userId --reusable --expiration "${ExpirationHrs}h" -o json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $json) { return '' }
    try {
        return [string]($json | ConvertFrom-Json).key
    } catch {
        return ''
    }
}

<#
.SYNOPSIS Reads the tailnet login server URL out of Headscale's own config file.
.DESCRIPTION `server_url` is the single source of truth for what a joining node must dial.
Deriving it from the LAN IP plus a guessed port is how scripts/headscale-setup.sh ended up
advertising :8080, which nothing listens on (compose publishes 8085 -> 8080).

Read from the host bind-mount rather than `docker exec`: the headscale image is distroless,
so there is no `sh` in the container to grep with.
.PARAMETER RepoRoot Repository root; the config lives at infra/headscale/config/config.yaml.
.OUTPUTS [string] e.g. http://localhost:8085, or '' when it cannot be read.
#>
function Get-HeadscaleServerUrl {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $configPath = Join-Path $RepoRoot 'infra\headscale\config\config.yaml'
    if (-not (Test-Path -LiteralPath $configPath)) { return '' }
    foreach ($line in (Get-Content -LiteralPath $configPath)) {
        if ($line -match '^\s*server_url:\s*(\S+)') { return $Matches[1].Trim('"').Trim("'") }
    }
    return ''
}

<#
.SYNOPSIS This machine's own tailnet IPv4, when it is enrolled in the tailnet.
.DESCRIPTION An off-LAN node dials the controller at its 100.64.0.0/10 address, not its
192.168.* one -- that is the whole point of the tailnet. Requires the tailscale CLI on PATH.
.OUTPUTS [string] e.g. 100.64.0.1, or '' when tailscale is absent or not connected.
#>
function Get-TailnetIPv4 {
    if (-not (Test-CommandExists 'tailscale')) { return '' }
    $ip = (tailscale ip -4 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or -not $ip) { return '' }
    return $ip.Trim()
}
