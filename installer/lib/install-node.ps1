<#
  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | One-click "join a swarm" path: decode join code -> reach controller -> ensure Node 20 -> build packages/oshal-chat -> seed config via env -> desktop shortcut -> launch.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Accept v2 join codes: join the Headscale tailnet (installing Tailscale if needed) before probing the controller, so a node outside the swarm's LAN can reach it.
  3 | maintainer@emeraldcoastsystemsgroup.com   | Full-Jarvis is now the install default: seed OSHAL_FULL_JARVIS=true so a fresh satellite opens the swarm-hosted cockpit (OIDC sign-in on first launch). -OrbOnly opts a worker-only box out.

  installer/lib/install-node.ps1 -- make THIS machine a worker node of someone else's swarm.

  The node app is packages/oshal-chat (Electron). Its ConfigStore reads OSHAL_CONTROL_PLANE_URL /
  OSHAL_SHARED_SECRET on load and persists them, so the very first launch is already configured
  and the human never opens the settings pane. The desktop shortcut deliberately does NOT carry
  those variables -- once persisted, the app's own settings UI is authoritative.

  By default a new node also gets OSHAL_FULL_JARVIS=true: on first launch it opens the full
  swarm-hosted Jarvis cockpit (prompting the swarm OIDC sign-in), with the orb window behind it
  as the local node console. Pass -OrbOnly for an unattended/worker-only box where nobody is
  present to sign in -- the mode can always be flipped later in Config -> Full Jarvis.

    .\installer\lib\install-node.ps1 -JoinCode OSJOIN1.xxxxx
    .\installer\lib\install-node.ps1 -ControlPlaneUrl http://192.168.1.5:35457 -SharedSecret abc...
    .\installer\lib\install-node.ps1 -JoinCode OSJOIN1.xxxxx -OrbOnly
#>

[CmdletBinding()]
param(
    [string]$JoinCode = '',        # the OSJOIN1.* token printed by the swarm installer
    [string]$ControlPlaneUrl = '', # or supply the two halves directly
    [string]$SharedSecret = '',
    [string]$EnrollmentToken = '', # oshal_pat_... from the cockpit's "Add this computer" — binds this node to YOU
    [string]$NodeName = '',        # how this machine shows up in the cockpit mesh view
    [switch]$WithCliTools,         # also npm-install codex / claude / cline globally
    [switch]$NoLaunch,             # install and configure, but do not open the app
    [switch]$OrbOnly               # skip Full-Jarvis: start as the thin orb + worker only
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$RepoRoot    = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$PackageDir  = Join-Path $RepoRoot 'packages\oshal-chat'
$LauncherCmd = Join-Path $RepoRoot 'installer\Open-Swarm-Node.cmd'
$MinNodeMajor = 20

# ---------------------------------------------------------------------------

<#
.SYNOPSIS Resolves the control-plane URL and shared secret from either input form.
.DESCRIPTION A join code is one paste; the split parameters exist for scripted installs.
.OUTPUTS [hashtable] @{ ControlPlaneUrl = ...; SharedSecret = ... }
#>
function Resolve-JoinTarget {
    if ($JoinCode) {
        try {
            $parsed = ConvertFrom-JoinCode -JoinCode $JoinCode
        } catch {
            Stop-WithError $_.Exception.Message "Re-copy the join code from the swarm machine's installer window."
        }
        return $parsed
    }
    if ($ControlPlaneUrl -and $SharedSecret) {
        return @{ ControlPlaneUrl = $ControlPlaneUrl.TrimEnd('/'); SharedSecret = $SharedSecret; HeadscaleUrl = ''; HeadscaleAuthKey = '' }
    }
    Stop-WithError "No join code supplied." "Run the installer on your swarm machine first -- it prints a join code."
    return $null  # unreachable; keeps the analyzer happy
}

<#
.SYNOPSIS Joins the swarm's tailnet when the join code carried tailnet credentials.
.DESCRIPTION A v2 join code means the controller lives at a 100.64.0.0/10 address that is
unreachable until this machine is on the same tailnet. So this must run BEFORE the controller
probe, not after. A v1 code (same LAN) skips the whole thing -- no VPN required, by design.

`tailscale up` is idempotent: re-running it on an already-connected node is a no-op.
.PARAMETER Target @{ HeadscaleUrl; HeadscaleAuthKey }
#>
function Connect-Tailnet {
    param([Parameter(Mandatory)][hashtable]$Target)
    if (-not $Target.HeadscaleUrl -or -not $Target.HeadscaleAuthKey) {
        Write-Step "Network"
        Write-Ok "Same-network join code -- no VPN needed"
        return
    }

    Write-Step "Joining the swarm's private network"
    if (-not (Test-CommandExists 'tailscale')) {
        Write-Warn "Tailscale is not installed. Trying winget..."
        if (-not (Install-WingetPackage -PackageId 'Tailscale.Tailscale')) {
            Stop-WithError "Tailscale is required for this join code and could not be installed." `
                "Install it from https://tailscale.com/download/windows then run this installer again."
        }
        Stop-WithError "Tailscale was installed, but this window cannot see it yet." `
            "Close this window and run the installer again."
    }

    tailscale up --login-server $Target.HeadscaleUrl --authkey $Target.HeadscaleAuthKey --accept-dns=false
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Could not join the tailnet at $($Target.HeadscaleUrl)." `
            "The key in a join code expires after 24 hours -- re-run install-swarm.ps1 -OffLan on the swarm machine for a fresh one."
    }
    $ip = Get-TailnetIPv4
    Write-Ok "On the tailnet as $ip"
}

<#
.SYNOPSIS Confirms the controller is reachable from this machine before installing anything.
.DESCRIPTION Failing here is the single most common real-world problem (Windows Firewall on the
swarm box, or a join code minted before the machine had a LAN address). Catching it up front
saves a five-minute Electron install that ends in a node that can never connect.
.PARAMETER Url The control-plane base URL.
#>
function Assert-ControllerReachable {
    param([Parameter(Mandatory)][string]$Url)
    Write-Step "Checking the swarm at $Url"
    if (Test-HttpOk "$Url/api/health") {
        Write-Ok "Swarm is reachable"
        return
    }
    Stop-WithError "Could not reach the swarm at $Url" `
        "On the swarm machine: is it running, and is the TCP port open to the LAN? Re-run its installer as Administrator to add the firewall rule. To join from a different network, get an off-LAN join code instead."
}

<#
.SYNOPSIS Ensures a Node.js runtime new enough for the node app is on PATH.
.DESCRIPTION Installs the LTS via winget when absent. A fresh winget install does not land on
the current process's PATH, so we stop and ask for a re-run rather than failing confusingly
three steps later inside npm.
#>
function Assert-NodeRuntime {
    Write-Step "Checking Node.js"
    if (-not (Test-CommandExists 'node')) {
        Write-Warn "Node.js is not installed. Trying winget..."
        if (Install-WingetPackage -PackageId 'OpenJS.NodeJS.LTS') {
            Stop-WithError "Node.js was installed, but this window cannot see it yet." `
                "Close this window and run the installer again."
        }
        Stop-WithError "Node.js is required and could not be installed automatically." `
            "Install the LTS from https://nodejs.org/ then run this installer again."
    }

    $version = (node -v)                       # e.g. v20.11.1
    $major = [int]($version.TrimStart('v').Split('.')[0])
    if ($major -lt $MinNodeMajor) {
        Stop-WithError "Node.js $version is too old (need $MinNodeMajor or newer)." "Install the current LTS from https://nodejs.org/"
    }
    Write-Ok "Node.js $version"
}

<#
.SYNOPSIS Installs dependencies and compiles the Electron node app.
.DESCRIPTION packages/oshal-chat's postinstall globally installs the codex / claude / cline CLIs.
That is what makes a worker node useful, but it is slow and network-bound, so it is opt-in via
-WithCliTools and skipped otherwise through the package's own OSHAL_SKIP_CLI_SETUP escape hatch.
#>
function Install-NodeApp {
    Write-Step "Installing the node app (this downloads Electron -- a few minutes)"
    if (-not (Test-Path -LiteralPath $PackageDir)) {
        Stop-WithError "Cannot find $PackageDir." "Run this installer from inside the Open Swarm folder."
    }

    Push-Location $PackageDir
    try {
        if ($WithCliTools) {
            Remove-Item Env:\OSHAL_SKIP_CLI_SETUP -ErrorAction SilentlyContinue
            Write-Info "Also installing the codex / claude / cline CLIs."
        } else {
            $env:OSHAL_SKIP_CLI_SETUP = '1'
            Write-Info "Skipping the AI CLI install (re-run with -WithCliTools to add them)."
        }

        npm install
        if ($LASTEXITCODE -ne 0) { Stop-WithError "npm install failed." "Scroll up for the npm error." }
        Write-Ok "Dependencies installed"

        npm run build
        if ($LASTEXITCODE -ne 0) { Stop-WithError "Build failed." "Scroll up for the TypeScript error." }
        Write-Ok "Node app built"
    } finally {
        Pop-Location
    }
}

<#
.SYNOPSIS Creates a Desktop shortcut pointing at the launcher.
.DESCRIPTION Best effort: a missing shortcut is cosmetic, and the launcher .cmd still works.
.PARAMETER Name Shortcut display name.
#>
function New-DesktopShortcut {
    param([Parameter(Mandatory)][string]$Name)
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $linkPath = Join-Path $desktop "$Name.lnk"
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($linkPath)
        $shortcut.TargetPath = $LauncherCmd
        $shortcut.WorkingDirectory = $RepoRoot
        $shortcut.Description = 'Open Swarm worker node'
        $shortcut.WindowStyle = 7   # start minimized; the Electron window is the real UI
        $shortcut.Save()
        Write-Ok "Added '$Name' to your Desktop"
    } catch {
        Write-Warn "Could not create the Desktop shortcut: $($_.Exception.Message)"
        Write-Info "Start the node any time with: $LauncherCmd"
    }
}

<#
.SYNOPSIS Launches the node app once with the connection settings in the environment.
.DESCRIPTION ConfigStore.load() reads these and writes them into its userData config.json, so
this first run is what actually configures the node. Every later launch (via the shortcut)
carries no environment and reads the persisted file, which keeps the app's settings pane
authoritative for anything the human changes there.
.PARAMETER Target   @{ ControlPlaneUrl; SharedSecret }
.PARAMETER ClientName How this node is labelled in the cockpit.
#>
function Start-NodeApp {
    param([Parameter(Mandatory)][hashtable]$Target, [Parameter(Mandatory)][string]$ClientName)
    Write-Step "Starting your node"
    $env:OSHAL_CONTROL_PLANE_URL = $Target.ControlPlaneUrl
    $env:OSHAL_SHARED_SECRET     = $Target.SharedSecret
    $env:OSHAL_CLIENT_NAME       = $ClientName
    $env:OSHAL_WORKER_ENABLED    = 'true'
    if ($EnrollmentToken) {
        # Exchanged ONCE on first launch for the enrolling user's verified sub, then cleared, so this
        # node registers bound to a real person. Without it the node comes up UNOWNED, and the swarm's
        # owner-scoped dispatch will not route that user's work to it.
        $env:OSHAL_ENROLLMENT_TOKEN = $EnrollmentToken
        Write-Info "Enrollment code supplied: this computer will register to your swarm account."
    } else {
        Write-Warn "No enrollment code: this node will be UNOWNED. Get one from the cockpit (Add a computer) so your own work can be routed here."
    }
    if ($OrbOnly) {
        # Explicit 'false' (not merely unset) so a re-install can turn the mode off
        # on a node whose persisted config already has it on.
        $env:OSHAL_FULL_JARVIS = 'false'
        Write-Info "Orb-only node: the full Jarvis cockpit stays off (enable later in Config)."
    } else {
        $env:OSHAL_FULL_JARVIS = 'true'
        Write-Info "Full Jarvis is on: the swarm cockpit opens after you sign in on first launch."
    }

    Start-Process -FilePath $LauncherCmd -WorkingDirectory $RepoRoot -WindowStyle Hidden
    Write-Ok "Node app launched -- look for the Open Swarm window"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

$target = Resolve-JoinTarget
$clientName = $NodeName
if (-not $clientName) { $clientName = "$env:COMPUTERNAME (Windows)" }

Connect-Tailnet -Target $target
Assert-ControllerReachable -Url $target.ControlPlaneUrl
Assert-NodeRuntime
Install-NodeApp
New-DesktopShortcut -Name 'Open Swarm Node'

if (-not $NoLaunch) { Start-NodeApp -Target $target -ClientName $clientName }

Write-Step "This machine is now a node"
Write-Info "Connected to: $($target.ControlPlaneUrl)"
Write-Info "Named:        $clientName"
Write-Info "It shows up in the swarm's cockpit under Mesh."
Write-Host ""
Write-Info "Start it again later from the 'Open Swarm Node' shortcut on your Desktop."

Write-Result -Key 'COCKPIT'   -Value "$($target.ControlPlaneUrl)/cockpit/"
Write-Result -Key 'NODENAME'  -Value $clientName

exit 0
