<#
  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | One-click "join a swarm" path: decode join code -> reach controller -> ensure Node 20 -> build packages/oshal-chat -> seed config via env -> desktop shortcut -> launch.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Accept v2 join codes: join the Headscale tailnet (installing Tailscale if needed) before probing the controller, so a node outside the swarm's LAN can reach it.
  3 | maintainer@emeraldcoastsystemsgroup.com   | Full-Jarvis is now the install default: seed OSHAL_FULL_JARVIS=true so a fresh satellite opens the swarm-hosted cockpit (OIDC sign-in on first launch). -OrbOnly opts a worker-only box out.
  4 | maintainer@emeraldcoastsystemsgroup.com   | The swarm-wide shared secret is gone from this installer, and the node now starts with Windows. REMOTE_CLIENT_REQUIRE_NODE_TOKEN retired that secret as a worker credential, so a node configured with it installed cleanly and was then REFUSED at register - a silent dead end. Resolve-JoinTarget now requires a device-bound -EnrollmentToken: -SharedSecret is refused by name, and a join code contributes only the controller address and (v2) the tailnet credentials while the secret inside it is discarded. A Startup-folder shortcut goes in beside the Desktop one so a worker node comes back after a reboot without a human, and both are read back through the .lnk rather than trusted because Save() returned.
  5 | maintainer@emeraldcoastsystemsgroup.com   | Say what a Startup entry actually does. It runs at LOGON, not at boot, so "comes back after a reboot with nobody present" was true only on an auto-logon machine - a claim the next reader would have paid for at the worst moment. The success line now says "when you next sign in" and names the locked-login-screen case.

  installer/lib/install-node.ps1 -- make THIS machine a worker node of someone else's swarm.

  The node app is packages/oshal-chat (Electron). Its ConfigStore reads OSHAL_CONTROL_PLANE_URL /
  OSHAL_SHARED_SECRET on load and persists them, so the very first launch is already configured
  and the human never opens the settings pane. The desktop shortcut deliberately does NOT carry
  those variables -- once persisted, the app's own settings UI is authoritative.

  By default a new node also gets OSHAL_FULL_JARVIS=true: on first launch it opens the full
  swarm-hosted Jarvis cockpit (prompting the swarm OIDC sign-in), with the orb window behind it
  as the local node console. Pass -OrbOnly for an unattended/worker-only box where nobody is
  present to sign in -- the mode can always be flipped later in Config -> Full Jarvis.

  EVERY form needs -EnrollmentToken: this computer's own credential, minted for it in the cockpit
  (Get oshal -> Desktop -> Set up this computer). The swarm-wide shared secret is not a worker
  credential any more, so no form of this installer configures one.

    .\installer\lib\install-node.ps1 -ControlPlaneUrl http://192.168.1.5:35457 -EnrollmentToken oshal_pat_...
    .\installer\lib\install-node.ps1 -JoinCode OSJOIN1.xxxxx -EnrollmentToken oshal_pat_...
    .\installer\lib\install-node.ps1 -JoinCode OSJOIN2.xxxxx -EnrollmentToken oshal_pat_... -OrbOnly
#>

[CmdletBinding()]
param(
    [string]$JoinCode = '',        # the OSJOIN1.*/OSJOIN2.* code printed by the swarm installer
    [string]$ControlPlaneUrl = '', # or the swarm's address on its own
    [string]$SharedSecret = '',    # RETIRED. Still declared so passing it gets an explanation, not a binding error
    [string]$EnrollmentToken = '', # REQUIRED. oshal_pat_... from the cockpit's "Set up this computer" -- binds this node to YOU
    [string]$ClientId = '',        # the device id a DEVICE-BOUND token was minted for; the node adopts it
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
.SYNOPSIS Resolves the control-plane URL and this node's DEVICE-BOUND bearer credential.
.DESCRIPTION There is one credential a node may hold: a token minted for THIS computer
(oshal_cli_tokens.node_client_id), which authenticates only this device's worker plane and can
be rotated or revoked without touching any other machine.

The swarm-wide secret is not a second way in. REMOTE_CLIENT_REQUIRE_NODE_TOKEN retired it as a
worker credential, so a node configured with it installs perfectly and is then refused at
POST /api/remote-clients/register -- an install that reports success and produces a node that
can never join. So it is refused HERE, by name, while the message can still be read.

A join code still earns its place: it carries the controller's address, and a v2 code carries
the tailnet credentials that make that address reachable at all. The secret inside it is
discarded.
.OUTPUTS [hashtable] @{ ControlPlaneUrl; SharedSecret; HeadscaleUrl; HeadscaleAuthKey }
#>
function Resolve-JoinTarget {
    if ($SharedSecret) {
        Stop-WithError "The swarm-wide shared secret is no longer a node credential." `
            "Enrol this computer instead: in the cockpit open Get oshal -> Desktop -> Set up this computer, then run the file it downloads, or pass the token it shows here as -EnrollmentToken."
    }
    if (-not $EnrollmentToken) {
        Stop-WithError "No enrolment token supplied." `
            "Every node joins on a token bound to ONE computer. In the cockpit open Get oshal -> Desktop -> Set up this computer, then run the file it downloads, or pass its token here as -EnrollmentToken."
    }
    if ($JoinCode) {
        try {
            $parsed = ConvertFrom-JoinCode -JoinCode $JoinCode
        } catch {
            Stop-WithError $_.Exception.Message "Re-copy the join code from the swarm machine's installer window."
        }
        # Only the address halves are kept. $parsed.SharedSecret is the swarm-wide value and is
        # deliberately dropped on the floor -- reading it here is what used to configure a node
        # that the control plane then refused.
        return @{
            ControlPlaneUrl  = ([string]$parsed.ControlPlaneUrl).TrimEnd('/')
            SharedSecret     = $EnrollmentToken
            HeadscaleUrl     = [string]$parsed.HeadscaleUrl
            HeadscaleAuthKey = [string]$parsed.HeadscaleAuthKey
        }
    }
    if ($ControlPlaneUrl) {
        # The token goes in the SharedSecret slot because that slot is what the node SENDS as its
        # bearer credential (`config.sharedSecret` in mesh-client.ts / worker.ts). The field names
        # the slot, not the swarm-wide value that used to fill it. The same token is also passed
        # as OSHAL_ENROLLMENT_TOKEN below, which is what binds the node to a person; here it is
        # what authenticates the node's calls.
        return @{ ControlPlaneUrl = $ControlPlaneUrl.TrimEnd('/'); SharedSecret = $EnrollmentToken; HeadscaleUrl = ''; HeadscaleAuthKey = '' }
    }
    Stop-WithError "No swarm address supplied." "Pass -JoinCode from the swarm machine, or -ControlPlaneUrl http://<swarm-host>:35457, alongside your -EnrollmentToken."
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
.SYNOPSIS Writes a shortcut to the launcher into one Windows folder.
.DESCRIPTION Used twice: the Desktop copy (how a person opens the node) and the Startup copy
(how the node comes back on its own at the next LOGON -- Startup is per-user, so a machine sitting
at a locked login screen starts nothing until someone signs in). Both are READ BACK through the
.lnk, because a Save() that returned can still have recorded nothing -- and a startup entry
pointing nowhere is indistinguishable from one that works until the machine is restarted.
.PARAMETER Directory Where the .lnk goes.
.PARAMETER Name      Shortcut display name.
.OUTPUTS [string] The .lnk path, or '' when it could not be written.
#>
function New-LauncherShortcut {
    param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$Name)
    try {
        if (-not (Test-Path -LiteralPath $Directory)) {
            New-Item -ItemType Directory -Path $Directory -Force | Out-Null
        }
        $linkPath = Join-Path $Directory "$Name.lnk"
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($linkPath)
        $shortcut.TargetPath = $LauncherCmd
        $shortcut.WorkingDirectory = $RepoRoot
        $shortcut.Description = 'Open Swarm worker node'
        $shortcut.WindowStyle = 7   # start minimized; the Electron window is the real UI
        $shortcut.Save()
        $written = $shell.CreateShortcut($linkPath)
        if ($written.TargetPath -ne $LauncherCmd) {
            throw "it recorded '$($written.TargetPath)' instead of '$LauncherCmd'"
        }
        return $linkPath
    } catch {
        Write-Warn "Could not write the '$Name' shortcut in ${Directory}: $($_.Exception.Message)"
        Write-Info "Start the node any time with: $LauncherCmd"
        return ''
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
    if ($ClientId) {
        # The token is bound to THIS id, so the node must register as it rather than minting
        # its own -- the control plane refuses a bound token that names a different device.
        $env:OSHAL_CLIENT_ID = $ClientId
    }
    $env:OSHAL_WORKER_ENABLED    = 'true'
    # Exchanged ONCE on first launch for the enrolling user's verified sub, then cleared, so this
    # node registers bound to a real person -- which is what lets owner-scoped dispatch route that
    # person's work here. Resolve-JoinTarget refuses without one, so it is always set.
    $env:OSHAL_ENROLLMENT_TOKEN = $EnrollmentToken
    Write-Info "Enrolment token supplied: this computer registers to your swarm account."
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

Write-Step "Shortcuts"
if (New-LauncherShortcut -Directory ([Environment]::GetFolderPath('Desktop')) -Name 'Open Swarm Node') {
    Write-Ok "Added 'Open Swarm Node' to your Desktop"
}
# The Startup copy is the difference between a node and a thing somebody has to remember to
# open. Per-user Startup needs no elevation and no scheduled task, and a person removes it the
# same way they remove any other startup item.
$startupLink = New-LauncherShortcut -Directory ([Environment]::GetFolderPath('Startup')) -Name 'Open Swarm Node'
if ($startupLink) {
    Write-Ok "This node starts again by itself when you next sign in to Windows"
    Write-Info "Startup is per-user: after a reboot it waits at the login screen until someone signs in."
} else {
    Write-Warn "This node will NOT come back on its own when you sign in."
    Write-Info "Put a shortcut to $LauncherCmd in shell:startup to fix that."
}

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
