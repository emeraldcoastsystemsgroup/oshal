<#
  CHANGE LOG
  ---------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  ---------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | The "Connect your AI account" step. Drives the REAL vendor CLI login on the host (claude auth login / codex login / gemini) so the browser OAuth redirect happens where the user's browser is, then the resulting credential dir is what docker-compose already mounts read-only into the bots (~/.claude, ~/.codex, ~/.gemini). We do NOT broker our own OAuth client — that is impossible (the vendor client ids are internal) and, for Anthropic, a ToS violation. We invoke the vendor's own login, exactly like the VS Code Claude Code extension does, and consume its output.

  WHY HOST-SIDE: the redirect callback is a localhost port the CLI listens on (codex uses :1455; claude uses a random port). A bot CONTAINER can't open the user's browser and the browser can't reach the container's localhost, so the login must run on the host and the credential is mounted in. This is why the login buttons live in the installer, not the cockpit.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)
#>

Set-StrictMode -Version Latest

<#
.SYNOPSIS The providers we can connect, grounded in each CLI's REAL login command (verified 2026-07-08).
.DESCRIPTION
  Cli        - the binary on PATH.
  LoginArgs  - the exact subcommand that runs the browser OAuth redirect and writes the credential.
               $null = the CLI has no non-interactive login subcommand (gemini) — detect + guide only.
  CredPath   - the credential the vendor login writes AND that docker-compose mounts into the bots.
               Presence of this file is the authoritative "connected" signal.
  EnvProvider- the FORCE_LLM_PROVIDER / LLM_PROVIDER value that makes this the swarm's default.
  KeyEnv     - the API-key env var accepted as a compliant fallback (paste path).
#>
function Get-AiProviders {
    # NOTE: not $home — that is a read-only automatic variable in PowerShell.
    $userHome = [Environment]::GetFolderPath('UserProfile')
    return @(
        [ordered]@{
            Id = 'claude'; Name = 'Claude'; Cli = 'claude';
            LoginArgs = @('auth', 'login'); StatusArgs = @('auth', 'status');
            CredPath = (Join-Path $userHome '.claude\.credentials.json');
            EnvProvider = 'claude-code'; KeyEnv = 'ANTHROPIC_API_KEY';
            Note = 'Claude Pro/Max or Console. Opens your browser to approve (Claude Code''s own login).'
        },
        [ordered]@{
            Id = 'codex'; Name = 'ChatGPT (Codex)'; Cli = 'codex';
            LoginArgs = @('login'); StatusArgs = $null;
            CredPath = (Join-Path $userHome '.codex\auth.json');
            EnvProvider = 'openai-codex'; KeyEnv = 'OPENAI_API_KEY';
            Note = 'ChatGPT login. Opens your browser (callback on localhost:1455).'
        },
        [ordered]@{
            Id = 'gemini'; Name = 'Gemini'; Cli = 'gemini';
            LoginArgs = $null; StatusArgs = $null;
            CredPath = (Join-Path $userHome '.gemini\oauth_creds.json');
            EnvProvider = 'gemini'; KeyEnv = 'GEMINI_API_KEY';
            Note = 'Google login. Run "gemini" once and sign in, or paste a GEMINI_API_KEY.'
        }
    )
}

<#
.SYNOPSIS True when the provider's CLI is on PATH.
#>
function Test-AiCliPresent {
    param([Parameter(Mandatory)][hashtable]$Provider)
    return [bool](Get-Command $Provider.Cli -ErrorAction SilentlyContinue)
}

<#
.SYNOPSIS True when the provider is already logged in — the credential file the login writes exists.
.DESCRIPTION Fast and side-effect-free: checks the exact file docker-compose mounts into the bots, so
  "connected here" == "the bots will see it". No subprocess, so it's safe to poll.
#>
function Test-AiConnected {
    param([Parameter(Mandatory)][hashtable]$Provider)
    return (Test-Path -LiteralPath $Provider.CredPath)
}

<#
.SYNOPSIS Runs the vendor's REAL login (the browser OAuth redirect), then reports whether it landed.
.DESCRIPTION Blocks while the browser flow completes (same as running `codex login` in a terminal).
  Returns $true only if the credential file now exists. Never throws — a cancelled login is just $false.
#>
function Invoke-AiLogin {
    param([Parameter(Mandatory)][hashtable]$Provider)
    if (-not (Test-AiCliPresent -Provider $Provider)) {
        Write-Fail "$($Provider.Name): the '$($Provider.Cli)' command isn't installed on this machine."
        Write-Info "Re-run the installer and tick 'install the AI command-line tools', or install $($Provider.Cli) yourself."
        return $false
    }
    if ($null -eq $Provider.LoginArgs) {
        Write-Info "$($Provider.Name) has no scriptable login. Run '$($Provider.Cli)' once and sign in, then choose Re-check."
        return (Test-AiConnected -Provider $Provider)
    }
    Write-Info "Opening your browser to sign in to $($Provider.Name). Approve there, then come back."
    try {
        & $Provider.Cli @($Provider.LoginArgs)
    } catch {
        Write-Fail "$($Provider.Name) login did not complete: $_"
        return $false
    }
    if (Test-AiConnected -Provider $Provider) {
        Write-Ok "$($Provider.Name) connected."
        return $true
    }
    Write-Fail "$($Provider.Name) login finished but no credential was written ($($Provider.CredPath))."
    return $false
}

<#
.SYNOPSIS The console "Connect your AI account" step. Returns the EnvProvider to make default, or ''.
.DESCRIPTION Lists each provider's state (connected / available / not installed), lets the user sign in
  to any of them, and returns the default provider to write into .env. Anything already connected on the
  host is honoured without a re-login. In -NonInteractive mode it only DETECTS (never prompts) and picks
  the first already-connected provider — the GUI, which pre-decides, passes -NonInteractive.
.OUTPUTS [string] The EnvProvider value for the chosen default (e.g. 'claude-code'), or '' if none.
#>
function Invoke-ConnectAiStep {
    param([switch]$NonInteractive)
    Write-Step "Connect your AI account (optional)"
    $providers = Get-AiProviders

    foreach ($p in $providers) {
        if (Test-AiConnected -Provider $p) { Write-Ok "$($p.Name): already connected" }
        elseif (Test-AiCliPresent -Provider $p) { Write-Info "$($p.Name): available - not signed in. $($p.Note)" }
        else { Write-Info "$($p.Name): CLI not installed" }
    }

    $connected = @($providers | Where-Object { Test-AiConnected -Provider $_ })
    if ($NonInteractive) {
        if ($connected.Count -gt 0) {
            Write-Ok "Using $($connected[0].Name) as the default provider."
            return $connected[0].EnvProvider
        }
        Write-Info "No account connected - the swarm boots in offline noop mode. The cockpit will offer you a"
        Write-Info "free AI (OpenRouter / Groq / Gemini, no card) or your own Claude/ChatGPT on first open."
        return ''
    }

    # Interactive: offer to sign in to anything not yet connected.
    foreach ($p in $providers) {
        if (Test-AiConnected -Provider $p) { continue }
        if (-not (Test-AiCliPresent -Provider $p)) { continue }
        $ans = Read-Host "Sign in to $($p.Name) now? [y/N]"
        if ($ans -match '^(y|yes)$') { [void](Invoke-AiLogin -Provider $p) }
    }

    $connected = @($providers | Where-Object { Test-AiConnected -Provider $_ })
    if ($connected.Count -eq 0) {
        Write-Info "No account connected - booting in offline noop mode. On first cockpit open you can connect a"
        Write-Info "free AI (OpenRouter / Groq / Gemini, no card) or your own Claude/ChatGPT."
        return ''
    }
    $default = $connected[0]
    Write-Ok "Default provider: $($default.Name)"
    return $default.EnvProvider
}
