<#
  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Native PowerShell port of scripts/install.sh for the one-click Windows installer: preflight -> .env seed (mints REMOTE_CLIENT_SHARED_SECRET) -> build -> up -> health -> verify -> firewall -> print join code.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Added the resource doctor, minting of the three fail-closed secrets (JWT/ENCRYPTION/SWARM_SERVICE), -Dev hot-swap mode, and -OffLan (Headscale pre-auth key packed into a v2 join code).
  3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed a hard parse error that made the whole Windows installer dead-on-arrival: `$env$env:FORCE_LLM_PROVIDER` (doubled sigil) -> `$env:FORCE_LLM_PROVIDER`, so zero-keys mode sets noop as intended. Dropped the stale `--profile little-monsters` compose arg (profile left with the ADR-085 store carve; matches scripts/install.sh's empty PROFILE_ARGS).

  installer/lib/install-swarm.ps1 -- make THIS machine the swarm controller.

  Runs standalone from a terminal, or as a subprocess of installer/install.ps1 (the GUI).
  Mirrors scripts/install.sh step for step, plus what the bash installer never did:
    * checks the machine actually has the RAM/disk/cores the stack needs,
    * mints REMOTE_CLIENT_SHARED_SECRET so other machines can actually join,
    * mints JWT_SECRET / ENCRYPTION_KEY / SWARM_SERVICE_SECRET, whose absence is silent,
    * pins OSHAL_DOCKER_PROJECT_ROOT to wherever the repo really lives, so dynamic bot
      insertion works outside the one path hardcoded in docker-compose.oshal-local.yml, and
    * optionally packs tailnet credentials into the join code so a node elsewhere can dial in.

    .\installer\lib\install-swarm.ps1
    .\installer\lib\install-swarm.ps1 -Dev          # hot-swap: tsx watch over the mounted source
    .\installer\lib\install-swarm.ps1 -OffLan       # join code works from outside this LAN
    .\installer\lib\install-swarm.ps1 -Down
#>

[CmdletBinding()]
param(
    [switch]$SkipBuild,       # reuse the image already built
    [switch]$Minimal,         # controller + infra only, no worker bots
    [switch]$WithKeys,        # use the real providers in .env instead of the noop stub harness
    [switch]$NoVerify,        # skip the post-install verification pass
    [switch]$Dev,             # hot-swap: bind-mount src/ and run tsx watch (docker-compose.hotswap.yml)
    [switch]$OffLan,          # mint a Headscale pre-auth key and pack it into the join code
    [string]$OperatorEmail,   # who administers this swarm (OSHAL_OPERATOR_EMAILS). Blank = demo login only.
    [switch]$NonInteractive,  # never prompt (the GUI passes this; it decides for the user up front)
    [switch]$Down,            # stop and remove the stack
    [switch]$ConnectOnly      # ONLY run the "connect an AI account" login flow, then exit (Connect-AI.bat)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'connect-ai.ps1')

$RepoRoot      = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ComposeFile   = 'docker-compose.oshal-local.yml'
$ImageName     = 'oshal-bot:latest'   # must match the compose OSHAL_BOT_IMAGE default
$DbContainer   = 'oshal-local-db'
$RedisContainer= 'oshal-local-redis'
$EnvFile       = Join-Path $RepoRoot '.env'

Set-Location $RepoRoot

$CockpitPort = $env:OSHAL_API_PORT
if (-not $CockpitPort) { $CockpitPort = '35457' }
$BaseUrl = "http://localhost:$CockpitPort"

# ---------------------------------------------------------------------------

<#
.SYNOPSIS Builds the docker compose argument prefix: base file, optional hot-swap overlay, bot profile.
.DESCRIPTION Compose applies `-f` files left to right and the last one wins, so the hot-swap
override must follow the base file. It replaces oshal-api's command with `tsx watch` over
bind-mounted source, which is what makes edits to src/ live without a rebuild.
.OUTPUTS [string[]]
#>
function Get-ComposeArgs {
    $composeArgs = @('compose', '-f', $ComposeFile)
    if ($Dev) { $composeArgs += @('-f', 'docker-compose.hotswap.yml') }
    # The default (non-minimal) up starts every profile-less service — the full swarm. There is no
    # bot profile to add: the little-monsters demo left for the oshal-applications store (ADR-085),
    # and every other app now hot-loads via POST /api/swarm/apps/load, not a compose profile. This
    # mirrors scripts/install.sh, whose PROFILE_ARGS is likewise empty.
    return $composeArgs
}

<#
.SYNOPSIS Stops and removes every profile of the stack.
#>
function Invoke-TearDown {
    Write-Step "Stopping the swarm"
    docker compose -f $ComposeFile --profile build --profile incident down --remove-orphans
    Write-Ok "Stopped and removed."
    exit 0
}

<#
.SYNOPSIS Pins the swarm's default LLM provider into .env (FORCE_LLM_PROVIDER + LLM_PROVIDER).
.PARAMETER Provider The EnvProvider value from the connect step, e.g. 'claude-code' / 'openai-codex'.
#>
function Set-SwarmProvider {
    param([Parameter(Mandatory)][string]$Provider)
    Set-EnvFileValue -Path $EnvFile -Key 'FORCE_LLM_PROVIDER' -Value $Provider
    Set-EnvFileValue -Path $EnvFile -Key 'LLM_PROVIDER' -Value $Provider
    Write-Ok "Swarm default provider set to $Provider"
}

<#
.SYNOPSIS Runs ONLY the connect-an-AI-account login, writes the provider to .env, then exits.
.DESCRIPTION Launched by Connect-AI.bat in its OWN visible console window — the GUI installer's child
  runs with no window and piped stdio (CreateNoWindow), so the vendor login (which opens a browser and
  needs a real console) cannot run there. This is that console. No Docker needed to sign in; if the
  stack is already running, the new provider takes effect on the next restart.
#>
function Invoke-ConnectOnly {
    $provider = Invoke-ConnectAiStep
    if ($provider) {
        Set-SwarmProvider -Provider $provider
        if (Test-HttpOk "$BaseUrl/api/health") {
            Write-Info "The swarm is running. Restart it to pick up ${provider}:"
            Write-Info "  docker compose -f $ComposeFile up -d --force-recreate --no-deps oshal-api"
        } else {
            Write-Info "Start (or re-run) the installer and your swarm will use ${provider}."
        }
    } else {
        Write-Info "No account connected. Nothing changed; you can run this again any time."
    }
    exit 0
}

<#
.SYNOPSIS Verifies Docker Desktop is installed and its daemon is answering.
.DESCRIPTION On a clean Windows box Docker is the one hard prerequisite. If winget can
install it we do, but the daemon still needs a manual first launch (and often a reboot),
so we stop with an instruction rather than pretending to continue.
#>
function Assert-Docker {
    Write-Step "Checking Docker Desktop"
    if (-not (Test-CommandExists 'docker')) {
        Write-Warn "Docker Desktop is not installed. Trying winget..."
        if (Install-WingetPackage -PackageId 'Docker.DockerDesktop') {
            Stop-WithError "Docker Desktop was installed, but it has not started yet." `
                "Launch Docker Desktop, wait for the whale icon to go steady, then run this installer again."
        }
        Stop-WithError "Docker Desktop is required and could not be installed automatically." `
            "Install it from https://docs.docker.com/desktop/install/windows-install/ then run this installer again."
    }

    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Docker is installed but the daemon is not responding." `
            "Start Docker Desktop, wait for it to say 'Engine running', then run this installer again."
    }
    Write-Ok "Docker daemon reachable"

    docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Docker Compose v2 is required." "Update Docker Desktop to a current release."
    }
    Write-Ok "Docker Compose v2 present"
}

<#
.SYNOPSIS Generates a secret into .env only if it is currently empty, and says which it did.
.DESCRIPTION Idempotent on purpose. Re-running the installer must never rotate a secret that
something already depends on -- rotating ENCRYPTION_KEY makes every stored OAuth token
undecryptable, and rotating REMOTE_CLIENT_SHARED_SECRET locks out every node that joined.
.PARAMETER Key   The .env variable.
.PARAMETER Label Human name for the log line.
.OUTPUTS [string] The value, existing or freshly minted.
#>
function Initialize-Secret {
    param([Parameter(Mandatory)][string]$Key, [Parameter(Mandatory)][string]$Label)
    $existing = Get-EnvFileValue -Path $EnvFile -Key $Key
    if ($existing) {
        Write-Ok "Reusing the existing $Label"
        return $existing
    }
    $value = New-JoinSecret
    Set-EnvFileValue -Path $EnvFile -Key $Key -Value $value
    Write-Ok "Generated a new $Label"
    return $value
}

<#
.SYNOPSIS Asks who administers this swarm, when nothing has answered that yet.
.DESCRIPTION Interactive runs prompt. The GUI passes -NonInteractive and supplies -OperatorEmail
from its own text box, so it never blocks on stdin.
.OUTPUTS [string] An email address, or '' to accept the demo login only.
#>
function Read-OperatorEmail {
    if ($OperatorEmail) { return $OperatorEmail.Trim() }
    if ($NonInteractive) { return '' }

    Write-Host ""
    Write-Info "Who administers this swarm? Operators can add computers and open the Security Center."
    Write-Info "Use the email your identity provider will report. Blank = the local demo login only."
    return (Read-Host "  Your email").Trim()
}

<#
.SYNOPSIS Makes sure at least one identity can administer this swarm.
.DESCRIPTION isOperator() (src/shared/middleware/authz.ts:54) is fail-closed: an empty
OSHAL_OPERATOR_EMAILS means there are NO operators, and every operator-gated route 403s with no
explanation. The default zero-keys install runs under MOCK_OIDC, which signs everyone in as
alex@demo.local, so that identity is always included -- otherwise the machine you just installed
on cannot open the page that adds the next machine.

Never rotates an existing allowlist: re-running the installer must not revoke anyone. Also never
touches MOCK_OIDC_EMAIL, because the mock `sub` derives from it and changing it would orphan
every row already keyed to the old user.
#>
function Initialize-OperatorAllowlist {
    $existing = Get-EnvFileValue -Path $EnvFile -Key 'OSHAL_OPERATOR_EMAILS'
    if ($existing) {
        Write-Ok "Reusing the existing operator allowlist ($existing)"
        return
    }

    $email = Read-OperatorEmail
    if ($email -and -not (Test-EmailLike -Address $email)) {
        Write-Warn "'$email' does not look like an email address -- ignoring it."
        $email = ''
    }

    $operators = @($script:MockOidcEmail)
    if ($email) { $operators = @($email) + $operators }
    $value = ($operators | Select-Object -Unique) -join ','
    Set-EnvFileValue -Path $EnvFile -Key 'OSHAL_OPERATOR_EMAILS' -Value $value

    if ($email) {
        Write-Ok "You are the operator ($email)"
        Write-Info "The demo login ($($script:MockOidcEmail)) is included too, since MOCK_OIDC signs you in as that."
    } else {
        Write-Ok "Operator: the local demo login ($($script:MockOidcEmail))"
        Write-Warn "Before exposing this swarm to a real identity provider, put YOUR email in OSHAL_OPERATOR_EMAILS."
    }
}

<#
.SYNOPSIS Seeds .env and guarantees every secret the stack silently needs actually exists.
.DESCRIPTION Four secrets, none of which any prior install path generated:
  REMOTE_CLIENT_SHARED_SECRET  -- unset means no machine can ever join. This is why
                                  "join a swarm" did not work out of the box.
  SWARM_SERVICE_SECRET         -- fail-closed in src/shared/middleware/authz.ts:116. Unset
                                  means bot-node -> controller calls quietly 401. Nothing logs it.
  JWT_SECRET                   -- otherwise dynamic-compose-service.ts:213 hands every launched
                                  bot the literal 'oshal-local-dev-secret-do-not-use-in-prod'.
  ENCRYPTION_KEY               -- the per-user AES-GCM connector-token store.
.OUTPUTS [string] The remote-client shared secret.
#>
function Initialize-EnvFile {
    Write-Step "Preparing configuration"
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        Copy-Item (Join-Path $RepoRoot '.env.example') $EnvFile
        Write-Ok "Created .env from .env.example"
    } else {
        Write-Ok "Using the existing .env"
    }

    $secret = Initialize-Secret -Key 'REMOTE_CLIENT_SHARED_SECRET' -Label 'join secret'
    [void](Initialize-Secret -Key 'SWARM_SERVICE_SECRET' -Label 'service-to-service secret')
    [void](Initialize-Secret -Key 'JWT_SECRET'           -Label 'bot JWT signing key')
    [void](Initialize-Secret -Key 'ENCRYPTION_KEY'       -Label 'connector-token encryption key')
    Initialize-OperatorAllowlist

    # Dynamic bot insertion resolves the compose file through the Docker VM's view of the host.
    $dockerRoot = ConvertTo-DockerHostPath -Path $RepoRoot
    Set-EnvFileValue -Path $EnvFile -Key 'OSHAL_DOCKER_PROJECT_ROOT' -Value $dockerRoot
    Write-Ok "Pinned the project root for Docker ($dockerRoot)"

    return $secret
}

<#
.SYNOPSIS Builds the single OSHAL image, tagged with every name the compose files expect.
.DESCRIPTION docker-compose.oshal-local.yml defaults to oshal-bot:latest; parts of the tree
still reference any-bot:latest. Tagging both is free and removes a class of "image not
found" support questions.
#>
function Invoke-ImageBuild {
    if ($SkipBuild) {
        Write-Step "Build (skipped)"
        docker image inspect $ImageName *> $null
        if ($LASTEXITCODE -ne 0) { Stop-WithError "-SkipBuild was set but $ImageName does not exist." "Run once without -SkipBuild." }
        Write-Ok "Reusing $ImageName"
        return
    }
    Write-Step "Building the OSHAL image (first build takes 3-5 minutes)"
    docker build -f Dockerfile.oshal -t $ImageName -t 'any-bot:latest' .
    if ($LASTEXITCODE -ne 0) { Stop-WithError "Image build failed." "Scroll up for the compiler error." }
    Write-Ok "Image built"
}

<#
.SYNOPSIS Starts the stack with the zero-keys defaults unless -WithKeys was passed.
#>
function Start-Stack {
    Write-Step "Starting the swarm"
    $env:MOCK_OIDC = 'true'
    if (-not $WithKeys) {
        $env:FORCE_LLM_PROVIDER = 'noop'
        Write-Ok "Provider: noop (no API keys or login needed)"
    } else {
        Write-Info "Provider: real, read from .env."
    }
    & docker @(Get-ComposeArgs) up -d
    if ($LASTEXITCODE -ne 0) { Stop-WithError "docker compose up failed." "Run: docker compose -f $ComposeFile logs" }
    Write-Ok "Containers started"
}

<#
.SYNOPSIS Blocks until the controller answers /api/health, printing a dot per poll.
#>
function Wait-ForController {
    Write-Step "Waiting for the controller to come up (up to 5 minutes)"
    $healthy = Wait-HttpOk -Url "$BaseUrl/api/health" -TimeoutSeconds 300 -OnTick { Write-Host "." -NoNewline }
    Write-Host ""
    if (-not $healthy) {
        Stop-WithError "The controller never became healthy." "Run: docker compose -f $ComposeFile logs oshal-api"
    }
    Write-Ok "Controller is healthy"
}

<#
.SYNOPSIS Runs one named check and folds its result into the pass/fail tallies.
.PARAMETER Name    Human-readable check name.
.PARAMETER Passed  Whether it passed.
.PARAMETER Detail  Shown only on failure -- what specifically was wrong.
.OUTPUTS [bool] Passed, so callers can accumulate.
#>
function Test-Check {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    if ($Passed) { Write-Ok $Name } else { Write-Fail "$Name -- $Detail" }
    return $Passed
}

<#
.SYNOPSIS Probes a container command, returning success as a bool. Never throws.
.PARAMETER Container Container name.
.PARAMETER Command   Argv to exec inside it.
.OUTPUTS [bool]
#>
function Test-ContainerCommand {
    param([string]$Container, [string[]]$Command)
    docker exec $Container @Command *> $null
    return ($LASTEXITCODE -eq 0)
}

<#
.SYNOPSIS Runs the post-install self-verification pass.
.OUTPUTS [int] The number of failed checks (0 = healthy install).
#>
function Invoke-Verification {
    if ($NoVerify) { Write-Step "Verification (skipped)"; return 0 }
    Write-Step "Verifying the install"

    $results = @()
    $healthyCount = @(docker ps --format '{{.Names}} {{.Status}}' | Where-Object { $_ -match 'oshal-local.*healthy' }).Count
    $results += Test-Check "containers healthy ($healthyCount)" ($healthyCount -ge 3) "fewer than 3 healthy oshal containers"
    $results += Test-Check "cockpit UI served" (Test-HttpOk "$BaseUrl/cockpit/") "GET /cockpit/ did not return 200"
    $results += Test-Check "postgres reachable" (Test-ContainerCommand $DbContainer @('pg_isready','-U','oshal','-d','oshal')) "pg_isready failed"
    $results += Test-Check "redis reachable" (Test-ContainerCommand $RedisContainer @('redis-cli','ping')) "redis-cli ping failed"
    $results += Test-Check "API responding" (Test-HttpOk "$BaseUrl/api/branding") "GET /api/branding failed"
    if (-not $Minimal) {
        $results += Test-Check "sample app served" (Test-HttpOk "$BaseUrl/api/education/dashboard") "GET /api/education/dashboard failed"
    }

    $failed = @($results | Where-Object { -not $_ }).Count
    Write-Host ""
    Write-Host "  $(@($results).Count - $failed) passed, $failed failed"
    return $failed
}

<#
.SYNOPSIS Opens the cockpit port to the LAN so other machines can join. Best effort.
.DESCRIPTION Requires elevation. Without it a node on the same LAN simply cannot reach the
controller, so we say exactly that instead of failing the whole install.
#>
function Open-CockpitFirewallPort {
    Write-Step "Opening the firewall for other machines"
    $ruleName = "Open Swarm cockpit ($CockpitPort)"
    if (-not (Test-Administrator)) {
        Write-Warn "Not running as Administrator -- skipped the firewall rule."
        Write-Info "Other machines will not reach this swarm until you allow TCP $CockpitPort inbound."
        Write-Info "To do it later, right-click Install-OpenSwarm.bat and choose 'Run as administrator'."
        return
    }
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($existing) { Write-Ok "Firewall rule already present"; return }

    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $CockpitPort -Profile Private | Out-Null
    Write-Ok "Allowed inbound TCP $CockpitPort on private networks"
}

<#
.SYNOPSIS Decides whether this join code should carry tailnet credentials.
.DESCRIPTION Embedding a Headscale pre-auth key makes the code work from anywhere, but it also
puts a live credential into a string the operator will paste around. So it is never automatic:
-OffLan opts in, and an interactive run asks. Returns $false the moment Headscale is absent.
.OUTPUTS [bool]
#>
function Test-ShouldGoOffLan {
    if (-not (Test-HeadscaleRunning)) { return $false }
    if ($OffLan) { return $true }
    if ($NonInteractive) { return $false }

    Write-Host ""
    Write-Info "Headscale is running on this machine, so nodes could join from outside this network."
    Write-Info "Saying yes mints a 24-hour pre-auth key and embeds it in the join code."
    $answer = Read-Host "  Make this join code work off-LAN? [y/N]"
    return ($answer -match '^[Yy]')
}

<#
.SYNOPSIS Builds the join code, packing tailnet credentials when the operator asked for them.
.PARAMETER Secret The controller's shared secret.
.OUTPUTS [string] An OSJOIN1.* or OSJOIN2.* token.
#>
function New-JoinCodeForThisSwarm {
    param([Parameter(Mandatory)][string]$Secret)

    if (Test-ShouldGoOffLan) {
        $hsUrl = Get-HeadscaleServerUrl -RepoRoot $RepoRoot
        $tailnetIp = Get-TailnetIPv4
        $authKey = New-HeadscalePreauthKey -UserName 'agentmesh' -ExpirationHrs 24

        if ($hsUrl -and $tailnetIp -and $authKey) {
            Write-Ok "Minted a 24-hour tailnet key -- this join code works from anywhere"
            Write-Info "Nodes will reach the controller at http://${tailnetIp}:$CockpitPort over the tailnet."
            return (ConvertTo-JoinCode -ControlPlaneUrl "http://${tailnetIp}:$CockpitPort" -SharedSecret $Secret `
                                       -HeadscaleUrl $hsUrl -HeadscaleAuthKey $authKey)
        }
        Write-Warn "Could not build an off-LAN join code; falling back to a LAN-only one."
        if (-not $tailnetIp) { Write-Info "This machine is not on the tailnet (no 'tailscale ip -4')." }
        if (-not $authKey)   { Write-Info "Headscale would not mint a pre-auth key." }
    }

    $lanIp = Get-LanIPv4
    if (-not $lanIp) {
        Write-Warn "No LAN address found -- the join code points at localhost and works only on this machine."
        return (ConvertTo-JoinCode -ControlPlaneUrl $BaseUrl -SharedSecret $Secret)
    }
    return (ConvertTo-JoinCode -ControlPlaneUrl "http://${lanIp}:$CockpitPort" -SharedSecret $Secret)
}

<#
.SYNOPSIS Prints the cockpit URL and the join code, and hands both back to the GUI.
.PARAMETER Secret The controller's shared secret.
#>
function Show-Summary {
    param([Parameter(Mandatory)][string]$Secret)

    $joinCode = New-JoinCodeForThisSwarm -Secret $Secret

    Write-Step "Your swarm is running"
    Write-Info "Cockpit:   $BaseUrl/cockpit/"
    Write-Info "Health:    $BaseUrl/api/health"
    if ($Dev) { Write-Info "Hot-swap:  edits under src/ reload without a rebuild." }
    if (-not $WithKeys) {
        Write-Host ""
        Write-Info "Running the keyless noop demo - placeholder replies until you connect real AI."
        Write-Info "Two ways to get real AI (the cockpit prompts you for one on first open):"
        Write-Info "  - Your Claude/ChatGPT account: double-click Connect-AI.bat, then restart."
        Write-Info "  - Free, no card: open the cockpit and connect OpenRouter / Groq / Gemini."
    }
    Write-Host ""
    Write-Info "To add another computer as a worker, run the installer there,"
    Write-Info "choose 'Join a swarm', and paste this join code:"
    Write-Host ""
    Write-Host "  $joinCode"
    Write-Host ""
    $operators = Get-OperatorAllowlist -RepoRoot $RepoRoot
    Write-Info "Lost it later? The swarm mints a fresh one at $BaseUrl/api/join/"
    Write-Info "Signed in as one of: $operators"

    Write-Result -Key 'COCKPIT'  -Value "$BaseUrl/cockpit/"
    Write-Result -Key 'JOINCODE' -Value $joinCode
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if ($Down) { Invoke-TearDown }
if ($ConnectOnly) { Invoke-ConnectOnly }   # login-only; no Docker needed, exits when done

Assert-Docker
[void](Invoke-SystemDoctor -RepoRoot $RepoRoot -CockpitPort $CockpitPort)
if ($Dev) {
    Write-Step "Developer mode"
    Write-Ok "Hot-swap overlay on: src/ is bind-mounted and the API runs under tsx watch."
    Write-Info "A new database migration still needs a rebuild; everything else is live."
}
$sharedSecret = Initialize-EnvFile

# Connect an AI account by driving the vendor's OWN login (claude auth login / codex login), so the
# browser OAuth redirect runs on the host where the browser is; the resulting ~/.claude / ~/.codex is
# already mounted into the bots by compose. Anything already logged in is used as-is. If a provider
# connects, switch the swarm off the echo harness and pin it as the default in .env.
$aiProvider = Invoke-ConnectAiStep -NonInteractive:$NonInteractive
if ($aiProvider) {
    $WithKeys = $true
    Set-SwarmProvider -Provider $aiProvider
}

Invoke-ImageBuild
Start-Stack
Wait-ForController
$failedChecks = Invoke-Verification
Open-CockpitFirewallPort
Show-Summary -Secret $sharedSecret

exit $failedChecks
