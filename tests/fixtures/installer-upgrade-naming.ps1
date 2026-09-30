<#
CHANGE LOG
-----------------------------------------------------------------------------
SEQ | AUTHOR | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual installer naming-upgrade excerpts with inert shortcut/firewall boundaries.

.SYNOPSIS Runs naming-upgrade behavior without running either installer.
.DESCRIPTION
Reads source only from OSHAL_UPGRADE_REPO. PowerShell AST extracts the two actual
upgrade functions; exact mainflow markers select only the shortcut phase.
Every Windows boundary is a script-local in-memory double. An AST allowlist
refuses unknown commands, indirect invocation, member invocation and scoped
variables before any extracted code can execute. No installer is dot-sourced.
.OUTPUTS
One JSON array: name, error (string or null), events (string array), remaining
(string array). Events record create operations and actual removed/success
messages, not an inferred pass. Successful cases repeat the actual flow twice.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS Parses source without evaluating its top-level installer statements.
.PARAMETER Text Source text.
.OUTPUTS A ScriptBlockAst; malformed source throws.
#>
function Read-FixtureAst {
    param([string]$Text)
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw "Installer fixture cannot parse source: $($errors[0].Message)" }
    return $ast
}

<#
.SYNOPSIS Extracts exactly one actual function definition, including its parameters.
.PARAMETER Ast Parsed installer, never evaluated.
.PARAMETER Name Required production function.
.OUTPUTS Function source text; missing/ambiguous definitions throw.
#>
function Get-FixtureFunction {
    param($Ast, [string]$Name)
    $matches = @($Ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
    }, $true))
    if ($matches.Count -ne 1) { throw "Expected exactly one production function: $Name" }
    return $matches[0].Extent.Text
}

<#
.SYNOPSIS Extracts the actual shortcut mainflow, replacing only known OS-folder lookups.
.PARAMETER Text Actual install-node.ps1 text.
.OUTPUTS An executable excerpt with inert folder labels; marker drift throws.
#>
function Get-FixtureShortcutFlow {
    param([string]$Text)
    $startMarker = 'Write-Step "Shortcuts"'
    $endMarker = 'if (-not $NoLaunch)'
    $start = $Text.IndexOf($startMarker, [StringComparison]::Ordinal)
    $end = $Text.IndexOf($endMarker, [StringComparison]::Ordinal)
    if ($start -lt 0 -or $end -le $start -or
        $Text.IndexOf($startMarker, $start + 1, [StringComparison]::Ordinal) -ge 0 -or
        $Text.IndexOf($endMarker, $end + 1, [StringComparison]::Ordinal) -ge 0) {
        throw 'Missing, duplicated or reordered shortcut mainflow markers'
    }
    $flow = $Text.Substring($start, $end - $start)
    foreach ($folder in @('Desktop', 'Startup')) {
        $expression = "[Environment]::GetFolderPath('$folder')"
        if ([regex]::Matches($flow, [regex]::Escape($expression)).Count -ne 1) {
            throw "Expected exactly one literal folder expression: $expression"
        }
        $flow = $flow.Replace($expression, "'fixture-$($folder.ToLowerInvariant())'")
    }
    return $flow
}

<#
.SYNOPSIS Refuses executable source that could escape the in-memory command boundary.
.PARAMETER Text Only the extracted definition/mainflow.
.OUTPUTS None; unsafe or unexpected syntax throws before execution.
#>
function Assert-FixtureBoundary {
    param([string]$Text)
    $allowed = @(
        'Join-Path', 'Test-Path', 'Remove-Item', 'New-LauncherShortcut',
        'Get-NetFirewallRule', 'Remove-NetFirewallRule', 'New-NetFirewallRule',
        'Test-Administrator', 'Remove-LegacyLauncherShortcut', 'Open-CockpitFirewallPort',
        'Write-Step', 'Write-Info', 'Write-Warn', 'Write-Ok', 'Write-Host',
        'Write-Output', 'Write-Warning', 'Write-Error', 'Write-Verbose',
        'Write-Debug', 'Write-Information', 'Write-Progress', 'Stop-WithError',
        'Out-Null', 'Where-Object', 'Select-Object'
    )
    $ast = Read-FixtureAst $Text
    foreach ($node in @($ast.FindAll({ param($n) $true }, $true))) {
        if ($node -is [System.Management.Automation.Language.CommandAst]) {
            $name = $node.GetCommandName()
            if (-not $name -or $name -notin $allowed -or
                $node.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown) {
                throw "Unmocked/indirect installer command refused: $name"
            }
        }
        if ($node -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) {
            throw 'Method invocation is outside the installer fixture boundary'
        }
        if ($node -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $node.VariablePath.UserPath.Contains(':')) {
            throw 'Scoped/environment variables are outside the installer fixture boundary'
        }
    }
}

# Source reads are the only real filesystem operations in this fixture.
if ([string]::IsNullOrWhiteSpace($env:OSHAL_UPGRADE_REPO)) { throw 'OSHAL_UPGRADE_REPO is required' }
$fixtureRepo = [System.IO.Path]::GetFullPath($env:OSHAL_UPGRADE_REPO)
$nodeSource = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($fixtureRepo, 'installer/lib/install-node.ps1'))
$swarmSource = [System.IO.File]::ReadAllText([System.IO.Path]::Combine($fixtureRepo, 'installer/lib/install-swarm.ps1'))
$removeDefinition = Get-FixtureFunction (Read-FixtureAst $nodeSource) 'Remove-LegacyLauncherShortcut'
$firewallDefinition = Get-FixtureFunction (Read-FixtureAst $swarmSource) 'Open-CockpitFirewallPort'
$shortcutFlow = Get-FixtureShortcutFlow $nodeSource
foreach ($excerpt in @($removeDefinition, $firewallDefinition, $shortcutFlow)) {
    Assert-FixtureBoundary $excerpt
}

# Script-local probes mask the corresponding real commands. None delegates to a cmdlet.
# Join-Path is also inert: labels are never resolved against a drive or provider.
function Join-Path {
    [CmdletBinding()]
    param([string]$Path, [string]$ChildPath)
    return ($Path.TrimEnd('/', '\') + '/' + $ChildPath)
}
function Test-Path {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$Path, [string]$PathType)
    $label = if ($LiteralPath) { $LiteralPath } else { $Path }
    return $script:Artifacts.Contains($label)
}
function Remove-Item {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$Path, [switch]$Force)
    $label = if ($LiteralPath) { $LiteralPath } else { $Path }
    if ($label -eq $script:FailureTarget) {
        if ($script:FailureMode -eq 'noop') { return }
        if ($script:FailureMode -eq 'throw') { throw "Synthetic shortcut removal failure: $label" }
    }
    [void]$script:Artifacts.Remove($label)
}
function New-LauncherShortcut {
    [CmdletBinding()]
    param([string]$Directory, [string]$Name)
    $label = Join-Path $Directory "$Name.lnk"
    [void]$script:Artifacts.Add($label)
    $script:Events.Add("create:$label")
    return $label
}
function Test-Administrator { [CmdletBinding()] param() return $script:IsAdministrator }
function Get-NetFirewallRule {
    [CmdletBinding()]
    param([string]$DisplayName)
    if ($script:QueryFails) {
        if ($PSBoundParameters['ErrorAction'] -eq 'SilentlyContinue') { return }
        throw 'Synthetic firewall query failure'
    }
    foreach ($label in $script:Artifacts) {
        if (-not $DisplayName -or $label -eq $DisplayName) {
            [pscustomobject]@{ DisplayName = $label; Name = $label }
        }
    }
}
function Remove-NetFirewallRule {
    [CmdletBinding()]
    param([string]$DisplayName, [Parameter(ValueFromPipeline)]$InputObject)
    process {
        $label = if ($DisplayName) { $DisplayName } else { $InputObject.DisplayName }
        if ($label -eq $script:FailureTarget) {
            if ($script:FailureMode -eq 'noop') { return }
            if ($script:FailureMode -eq 'throw') {
                if ($PSBoundParameters['ErrorAction'] -eq 'SilentlyContinue') { return }
                throw "Synthetic firewall removal failure: $label"
            }
        }
        [void]$script:Artifacts.Remove($label)
    }
}
function New-NetFirewallRule {
    [CmdletBinding()]
    param([string]$DisplayName, [string]$Direction, [string]$Action,
          [string]$Protocol, [int]$LocalPort, [string[]]$Profile)
    [void]$script:Artifacts.Add($DisplayName)
    $script:Events.Add("create:$DisplayName")
    [pscustomobject]@{ DisplayName = $DisplayName; Name = $DisplayName }
}
function Write-Info {
    [CmdletBinding()]
    param([string]$Message)
    if ($Message -match '^Removed\b') { $script:Events.Add("removed:$Message") }
}
function Write-Ok {
    [CmdletBinding()]
    param([string]$Message)
    $script:Events.Add("success:$Message")
}
function Write-Step { [CmdletBinding()] param([string]$Message) }
function Write-Warn { [CmdletBinding()] param([string]$Message) }
function Write-Host {
    [CmdletBinding()]
    param([Parameter(ValueFromRemainingArguments)]$Message,
          $ForegroundColor, $BackgroundColor, [switch]$NoNewline)
}
function Write-Output { [CmdletBinding()] param([Parameter(ValueFromRemainingArguments)]$Message) }
function Write-Warning { [CmdletBinding()] param([string]$Message) }
function Write-Verbose { [CmdletBinding()] param([string]$Message) }
function Write-Debug { [CmdletBinding()] param([string]$Message) }
function Write-Information { [CmdletBinding()] param($MessageData, $Tags) }
function Write-Progress { [CmdletBinding()] param($Activity, $Status, $PercentComplete) }
function Write-Error {
    [CmdletBinding()]
    param([string]$Message)
    if ($PSBoundParameters['ErrorAction'] -ne 'SilentlyContinue') { throw $Message }
}
function Stop-WithError { [CmdletBinding()] param([string]$Message, [string]$Detail) throw "$Message $Detail" }

# Dot-source ONLY audited function definitions, never an installer script or its whole AST.
. ([scriptblock]::Create($removeDefinition))
. ([scriptblock]::Create($firewallDefinition))
$shortcutAction = [scriptblock]::Create($shortcutFlow)
$CockpitPort = 35457
$LauncherCmd = 'fixture-launcher.cmd'
$legacyRule = "Open Swarm cockpit ($CockpitPort)"
$currentRule = "oshal cockpit ($CockpitPort)"

<#
.SYNOPSIS Seeds one isolated upgrade state including unrelated sentinel artifacts.
.PARAMETER Name Requested case name.
.OUTPUTS None; case data exists only in memory.
#>
function Initialize-UpgradeCase {
    param([string]$Name)
    $script:Artifacts = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [void]$script:Artifacts.Add('unrelated-sentinel')
    $script:Events = [System.Collections.Generic.List[string]]::new()
    $script:FailureMode = ''
    $script:FailureTarget = ''
    $script:QueryFails = $Name -eq 'firewall-query-fails'
    $script:IsAdministrator = $Name -ne 'firewall-no-admin'
    $hasOld = $Name -notmatch '(new-only|missing)$'
    $hasNew = $Name -match '(both|new-only)$'
    if ($Name.StartsWith('shortcuts-')) {
        foreach ($folder in @('fixture-desktop', 'fixture-startup')) {
            if ($hasOld) { [void]$script:Artifacts.Add("$folder/Open Swarm Node.lnk") }
            if ($hasNew) { [void]$script:Artifacts.Add("$folder/oshal Node.lnk") }
        }
        $script:FailureTarget = 'fixture-desktop/Open Swarm Node.lnk'
        if ($Name -eq 'shortcuts-startup-fails') { $script:FailureTarget = 'fixture-startup/Open Swarm Node.lnk' }
    } else {
        if ($hasOld) { [void]$script:Artifacts.Add($legacyRule) }
        if ($hasNew) { [void]$script:Artifacts.Add($currentRule) }
        $script:FailureTarget = $legacyRule
    }
    if ($Name -match '(delete-fails|startup-fails)$') { $script:FailureMode = 'throw' }
    if ($Name -match 'delete-noop$') { $script:FailureMode = 'noop' }
}

<#
.SYNOPSIS Executes actual extracted production behavior and records, rather than judges, it.
.PARAMETER Name Case to seed and execute; successful inputs run twice for idempotence.
.OUTPUTS One result object with arrays even when empty.
#>
function Invoke-UpgradeCase {
    param([string]$Name)
    Initialize-UpgradeCase $Name
    $failure = $null
    try {
        $repeats = if ($Name -match '(old-only|both|new-only|missing)$') { 2 } else { 1 }
        for ($iteration = 0; $iteration -lt $repeats; $iteration++) {
            if ($Name.StartsWith('shortcuts-')) { & $shortcutAction }
            else { Open-CockpitFirewallPort }
        }
    } catch {
        $failure = [string]$_.Exception.Message
    }
    return [pscustomobject]@{
        name = $Name
        error = $failure
        events = [string[]]$script:Events.ToArray()
        remaining = [string[]]@($script:Artifacts | Sort-Object)
    }
}

$caseNames = @(
    'shortcuts-old-only', 'shortcuts-both', 'shortcuts-new-only', 'shortcuts-missing',
    'shortcuts-delete-fails', 'shortcuts-delete-noop', 'shortcuts-startup-fails',
    'firewall-old-only', 'firewall-both', 'firewall-new-only', 'firewall-missing',
    'firewall-delete-fails', 'firewall-delete-noop', 'firewall-query-fails', 'firewall-no-admin'
)
$rows = @($caseNames | ForEach-Object { Invoke-UpgradeCase $_ })
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $rows -Depth 8 -Compress))
