<#
  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | WinForms install button: pick a role (run the swarm here / join a swarm), stream the chosen installer's output into a log pane, show the join code on success.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Added the swarm options panel: live resource doctor, developer (hot-swap) toggle, and an explicit off-LAN prompt before any Headscale key is minted.

  installer/install.ps1 -- the graphical front door. Launched by Install-OpenSwarm.bat.

  It does no installing itself. It picks a role, collects the one input that role needs, and
  runs installer/lib/install-<role>.ps1 as a child process, pumping its stdout into the log
  pane. That keeps the real work in plain console scripts a power user can run directly, and
  keeps this file to presentation only.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$LibDir = Join-Path $PSScriptRoot 'lib'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# Probes only -- Get-DockerCapacity, Test-HeadscaleRunning, etc. Nothing here mutates anything,
# so it is safe to call inline from the UI thread before the user has committed to an install.
. (Join-Path $LibDir 'common.ps1')

# Palette. Dark, because the cockpit is.
$ColBg      = [Drawing.Color]::FromArgb(24, 26, 31)
$ColCard    = [Drawing.Color]::FromArgb(35, 38, 46)
$ColCardHover = [Drawing.Color]::FromArgb(47, 51, 62)
$ColFg      = [Drawing.Color]::FromArgb(232, 234, 238)
$ColMuted   = [Drawing.Color]::FromArgb(150, 156, 168)
$ColAccent  = [Drawing.Color]::FromArgb(94, 168, 255)
$ColGood    = [Drawing.Color]::FromArgb(126, 211, 143)
$ColWarn   = [Drawing.Color]::FromArgb(232, 189, 106)
$ColBad    = [Drawing.Color]::FromArgb(240, 124, 124)

$script:Proc     = $null
$script:LogQueue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$script:Results  = @{}

# ---------------------------------------------------------------------------
# Widget factories
# ---------------------------------------------------------------------------

<#
.SYNOPSIS Builds a label with the installer's typography applied.
.PARAMETER Text  Label content.
.PARAMETER Size  Font size in points.
.PARAMETER Color Foreground colour.
.PARAMETER Bold  Render semibold.
.OUTPUTS [System.Windows.Forms.Label]
#>
function New-Label {
    param([string]$Text, [single]$Size = 9.75, [Drawing.Color]$Color = $ColFg, [switch]$Bold)
    $style = [Drawing.FontStyle]::Regular
    if ($Bold) { $style = [Drawing.FontStyle]::Bold }
    $label = New-Object Windows.Forms.Label
    $label.Text = $Text
    $label.Font = New-Object Drawing.Font('Segoe UI', $Size, $style)
    $label.ForeColor = $Color
    $label.BackColor = [Drawing.Color]::Transparent
    $label.AutoSize = $false
    return $label
}

<#
.SYNOPSIS Builds one clickable role card (the "install button").
.DESCRIPTION The whole panel is the hit target -- title, body and panel all forward the click --
because a small button inside a big card is exactly the thing a non-technical user misses.
.PARAMETER Title   Headline, e.g. "Run the swarm here".
.PARAMETER Body    Two or three lines of plain-language explanation.
.PARAMETER Needs   The one prerequisite, shown in muted text.
.PARAMETER OnClick Invoked when the card is chosen.
.OUTPUTS [System.Windows.Forms.Panel]
#>
function New-RoleCard {
    param([string]$Title, [string]$Body, [string]$Needs, [string]$Action, [scriptblock]$OnClick)
    $card = New-Object Windows.Forms.Panel
    $card.Size = New-Object Drawing.Size(390, 286)
    $card.BackColor = $ColCard
    $card.Cursor = [Windows.Forms.Cursors]::Hand

    # Bodies are single strings with blank lines between paragraphs. Do NOT hand-wrap them:
    # the Label wraps to its own width, and manual newlines produce ragged, clipped text.
    $titleLabel = New-Label -Text $Title -Size 15 -Bold
    $titleLabel.SetBounds(24, 24, 340, 32)
    $bodyLabel = New-Label -Text $Body -Size 10 -Color $ColMuted
    $bodyLabel.SetBounds(24, 62, 342, 140)
    $needsLabel = New-Label -Text $Needs -Size 8.5 -Color $ColAccent
    $needsLabel.SetBounds(24, 206, 342, 20)

    # A real button, even though the whole card is clickable: a flat panel does not read
    # as pressable to the person this installer exists for.
    $actionButton = New-FlatButton -Text $Action -Primary
    $actionButton.SetBounds(24, 232, 190, 38)
    $actionButton.Add_Click($OnClick)

    $card.Controls.AddRange(@($titleLabel, $bodyLabel, $needsLabel, $actionButton))

    $card.Add_MouseEnter({ $this.BackColor = $ColCardHover }.GetNewClosure())
    $card.Add_MouseLeave({ $this.BackColor = $ColCard }.GetNewClosure())
    $card.Add_Click($OnClick)
    foreach ($child in @($titleLabel, $bodyLabel, $needsLabel)) {
        $child.Add_Click($OnClick)
        $child.Add_MouseEnter({ $this.Parent.BackColor = $ColCardHover }.GetNewClosure())
    }
    return $card
}

<#
.SYNOPSIS Builds a flat accent button.
.PARAMETER Text    Caption.
.PARAMETER Primary Filled accent style rather than a muted outline.
.OUTPUTS [System.Windows.Forms.Button]
#>
function New-FlatButton {
    param([string]$Text, [switch]$Primary)
    $button = New-Object Windows.Forms.Button
    $button.Text = $Text
    $button.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $button.FlatAppearance.BorderSize = 0
    $button.Font = New-Object Drawing.Font('Segoe UI', 10, [Drawing.FontStyle]::Bold)
    $button.Height = 38
    $button.Cursor = [Windows.Forms.Cursors]::Hand
    if ($Primary) {
        $button.BackColor = $ColAccent
        $button.ForeColor = [Drawing.Color]::FromArgb(16, 18, 22)
    } else {
        $button.BackColor = $ColCard
        $button.ForeColor = $ColFg
    }
    return $button
}

# ---------------------------------------------------------------------------
# Child-process plumbing
# ---------------------------------------------------------------------------

<#
.SYNOPSIS Quotes a single argv token for the Windows command line.
.DESCRIPTION Windows PowerShell 5.1 runs on .NET Framework, which has no
ProcessStartInfo.ArgumentList -- arguments must be one pre-quoted string.
.PARAMETER Value The token.
.OUTPUTS [string] The token, double-quoted when it contains whitespace.
#>
function ConvertTo-QuotedArg {
    param([string]$Value)
    if ($Value -match '\s') { return '"' + $Value.Replace('"', '\"') + '"' }
    return $Value
}

<#
.SYNOPSIS Starts an installer script as a child PowerShell process with stdout redirected.
.DESCRIPTION Output lines land in a concurrent queue; a UI timer drains it. Doing it this way
(instead of running the work inline) is what keeps the window responsive during a five-minute
docker build, and gives Cancel something real to kill.
.PARAMETER ScriptName File under installer/lib to run.
.PARAMETER Arguments  Extra argv for that script.
.OUTPUTS [System.Diagnostics.Process]
#>
function Start-InstallerChild {
    param([Parameter(Mandatory)][string]$ScriptName, [string[]]$Arguments = @())

    $scriptPath = ConvertTo-QuotedArg (Join-Path $LibDir $ScriptName)
    $extra = ($Arguments | ForEach-Object { ConvertTo-QuotedArg $_ }) -join ' '

    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $PSHOME 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File $scriptPath $extra".Trim()
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = New-Object Diagnostics.Process
    $proc.StartInfo = $psi
    $proc.EnableRaisingEvents = $true

    $sink = { if ($EventArgs.Data) { $Event.MessageData.Enqueue($EventArgs.Data) } }
    Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $sink -MessageData $script:LogQueue | Out-Null
    Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived  -Action $sink -MessageData $script:LogQueue | Out-Null

    [void]$proc.Start()
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()
    return $proc
}

<#
.SYNOPSIS Appends one child line to the log pane, colourised by its prefix.
.DESCRIPTION RESULT: lines are the child's structured hand-back (cockpit URL, join code). They
are captured and swallowed rather than shown -- they are protocol, not prose.
.PARAMETER Box  The log RichTextBox.
.PARAMETER Line One line of child stdout.
#>
function Add-LogLine {
    param([Windows.Forms.RichTextBox]$Box, [string]$Line)
    if ($Line -match '^RESULT:([A-Z]+)=(.*)$') {
        $script:Results[$Matches[1]] = $Matches[2]
        return
    }
    $color = $ColMuted
    if     ($Line.StartsWith('[ok]')) { $color = $ColGood }
    elseif ($Line.StartsWith('[!]'))  { $color = $ColWarn }
    elseif ($Line.StartsWith('[x]'))  { $color = $ColBad }
    elseif ($Line.StartsWith('=='))   { $color = $ColFg }

    $Box.SelectionStart = $Box.TextLength
    $Box.SelectionLength = 0
    $Box.SelectionColor = $color
    $Box.AppendText($Line + [Environment]::NewLine)
    $Box.ScrollToCaret()
}

<#
.SYNOPSIS Drains the queue into the log pane and detects child exit.
.PARAMETER Box      The log RichTextBox.
.PARAMETER OnFinish Invoked with the exit code once the child has exited and its output is drained.
#>
function Update-LogPane {
    param([Windows.Forms.RichTextBox]$Box, [scriptblock]$OnFinish)
    $line = $null
    while ($script:LogQueue.TryDequeue([ref]$line)) { Add-LogLine -Box $Box -Line $line }

    if ($script:Proc -and $script:Proc.HasExited -and $script:LogQueue.IsEmpty) {
        $code = $script:Proc.ExitCode
        $script:Proc = $null
        & $OnFinish $code
    }
}

# ---------------------------------------------------------------------------
# Panels
# ---------------------------------------------------------------------------

<#
.SYNOPSIS Swaps the visible panel inside the form's content area.
.PARAMETER Container The host panel. Not named Host -- that shadows the automatic $Host variable.
.PARAMETER Panel     The panel to show.
#>
function Show-Panel {
    param([Windows.Forms.Control]$Container, [Windows.Forms.Control]$Panel)
    $Container.Controls.Clear()
    $Panel.Dock = [Windows.Forms.DockStyle]::Fill
    $Container.Controls.Add($Panel)
}

<#
.SYNOPSIS The role chooser: two cards, one decision.
.PARAMETER OnSwarm Invoked when "Run the swarm here" is chosen.
.PARAMETER OnNode  Invoked when "Join a swarm" is chosen.
.OUTPUTS [System.Windows.Forms.Panel]
#>
function New-ChooserPanel {
    param([scriptblock]$OnSwarm, [scriptblock]$OnNode)
    $panel = New-Object Windows.Forms.Panel
    $panel.BackColor = $ColBg

    $nl = [Environment]::NewLine

    $heading = New-Label -Text 'What should this computer do?' -Size 18 -Bold
    $heading.SetBounds(40, 24, 700, 34)
    $sub = New-Label -Text 'Pick one. You can add more computers later.' -Size 10 -Color $ColMuted
    $sub.SetBounds(40, 60, 700, 24)

    $swarmBody = "This computer becomes the brain. It runs the cockpit you open in a browser, " +
                 "and hands work out to any other computers you add." + $nl + $nl +
                 "Pick this if it is your only computer, or your main one." + $nl + $nl +
                 "Takes about 5 minutes."
    $swarmCard = New-RoleCard -Title 'Run the swarm here' -Body $swarmBody `
        -Needs 'Needs: Docker Desktop (installed for you if missing)' `
        -Action 'Set this up' -OnClick $OnSwarm
    $swarmCard.Location = New-Object Drawing.Point(40, 96)

    $nodeBody = "This computer becomes a worker. It runs jobs the swarm sends it, using this " +
                "machine's own logins, and gives you a chat window." + $nl + $nl +
                "Pick this if the swarm is already running elsewhere." + $nl + $nl +
                "You will need its join code."
    $nodeCard = New-RoleCard -Title 'Join a swarm' -Body $nodeBody `
        -Needs 'Needs: Node.js (installed for you if missing)' `
        -Action 'Enter join code' -OnClick $OnNode
    $nodeCard.Location = New-Object Drawing.Point(456, 96)

    $footer = New-Label -Text "Not sure? Choose 'Run the swarm here'. It works on its own, with nothing else set up." -Size 9 -Color $ColMuted
    $footer.SetBounds(40, 396, 800, 22)

    $panel.Controls.AddRange(@($heading, $sub, $swarmCard, $nodeCard, $footer))
    return $panel
}

<#
.SYNOPSIS Renders the doctor rows into a panel, colour-coded, with hints underneath.
.PARAMETER Panel Where to add the labels.
.PARAMETER Top   Y coordinate of the first row.
.OUTPUTS [int] Y coordinate just below the last row.
#>
function Add-DoctorRows {
    param([Windows.Forms.Panel]$Panel, [int]$Top)
    $y = $Top
    foreach ($row in (Get-DoctorReport -RepoRoot $RepoRoot -CockpitPort 35457)) {
        $color = $ColGood
        $mark = 'OK'
        if ($row.Level -eq 'warn') { $color = $ColWarn; $mark = '!' }
        if ($row.Level -eq 'bad')  { $color = $ColBad;  $mark = 'X' }

        $label = New-Label -Text "[$mark]  $($row.Label)" -Size 9.5 -Color $color
        $label.SetBounds(40, $y, 806, 20)
        $Panel.Controls.Add($label)
        $y += 20

        if ($row.Hint) {
            $hint = New-Label -Text "       $($row.Hint)" -Size 8.5 -Color $ColMuted
            $hint.SetBounds(40, $y, 806, 18)
            $Panel.Controls.Add($hint)
            $y += 18
        }
    }
    return $y
}

<#
.SYNOPSIS Adds the operator-email field, but only when nobody holds the role yet.
.DESCRIPTION Re-running the installer must never revoke whoever is already in
OSHAL_OPERATOR_EMAILS, so when the allowlist is populated this renders nothing and the doctor
row above simply reports who the operators are.
.PARAMETER Panel Where to add the controls.
.PARAMETER Top   Y coordinate to start at.
.OUTPUTS [hashtable] @{ TextBox; NextY } -- TextBox is empty and unrendered when not needed.
#>
function Add-OperatorEmailField {
    param([Windows.Forms.Panel]$Panel, [int]$Top)
    $box = New-Object Windows.Forms.TextBox
    if (Get-OperatorAllowlist -RepoRoot $RepoRoot) {
        return @{ TextBox = $box; NextY = $Top }
    }

    $label = New-Label -Text 'Your email (makes you the operator, so you can add computers later):' -Size 9 -Color $ColMuted
    $label.SetBounds(40, ($Top + 12), 806, 18)

    $box.SetBounds(40, ($Top + 32), 380, 26)
    $box.Font = New-Object Drawing.Font('Segoe UI', 9.5)
    $box.BackColor = $ColCard
    $box.ForeColor = $ColFg
    $box.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle

    $optional = New-Label -Text 'Optional. Blank means only the local demo login can administer this swarm.' -Size 8.5 -Color $ColMuted
    $optional.SetBounds(430, ($Top + 37), 416, 18)

    $Panel.Controls.AddRange(@($label, $box, $optional))
    return @{ TextBox = $box; NextY = ($Top + 62) }
}

<#
.SYNOPSIS Adds the two install toggles: developer mode, and letting off-LAN machines join.
.DESCRIPTION The off-LAN box is disabled unless Headscale is actually running here, because
ticking it otherwise would mint nothing and mislead. Same-network nodes never need it.
.PARAMETER Panel Where to add the checkboxes.
.PARAMETER Top   Y coordinate to start at.
.OUTPUTS [hashtable] @{ Dev; OffLan }
#>
function Add-SwarmToggles {
    param([Windows.Forms.Panel]$Panel, [int]$Top)

    $dev = New-Object Windows.Forms.CheckBox
    $dev.SetBounds(40, ($Top + 14), 806, 24)
    $dev.Text = 'Developer mode: edit the source and see it live, without rebuilding.'
    $dev.ForeColor = $ColMuted
    $dev.Font = New-Object Drawing.Font('Segoe UI', 9)

    $offLan = New-Object Windows.Forms.CheckBox
    $offLan.SetBounds(40, ($Top + 42), 806, 24)
    $offLan.Font = New-Object Drawing.Font('Segoe UI', 9)
    $offLan.ForeColor = $ColMuted
    if (Test-HeadscaleRunning) {
        $offLan.Text = 'Let computers outside this network join (mints a 24-hour VPN key into the join code).'
        $offLan.Enabled = $true
    } else {
        $offLan.Text = 'Let computers outside this network join -- needs Headscale running here. Same-network nodes work without it.'
        $offLan.Enabled = $false
    }

    $Panel.Controls.AddRange(@($dev, $offLan))
    return @{ Dev = $dev; OffLan = $offLan }
}

<#
.SYNOPSIS The pre-install panel: what this machine has, and the two choices worth making.
.DESCRIPTION Shown before anything is built. The off-LAN checkbox is disabled unless Headscale
is actually running here, because ticking it otherwise would mint nothing and mislead.
.PARAMETER OnBack     Return to the chooser.
.PARAMETER OnContinue Invoked with (devMode, offLan).
.OUTPUTS [System.Windows.Forms.Panel]
#>
function New-SwarmOptionsPanel {
    param([scriptblock]$OnBack, [scriptblock]$OnContinue)
    $panel = New-Object Windows.Forms.Panel
    $panel.BackColor = $ColBg

    $heading = New-Label -Text 'Before we start' -Size 18 -Bold
    $heading.SetBounds(40, 20, 700, 32)
    $sub = New-Label -Text 'What this computer has. Warnings are fine to ignore if you know why.' -Size 9.5 -Color $ColMuted
    $sub.SetBounds(40, 54, 780, 20)
    $panel.Controls.AddRange(@($heading, $sub))

    $y = Add-DoctorRows -Panel $panel -Top 84

    $operator = Add-OperatorEmailField -Panel $panel -Top $y
    $emailBox = $operator.TextBox
    $y = $operator.NextY

    $toggles = Add-SwarmToggles -Panel $panel -Top $y
    $devCheck = $toggles.Dev
    $offLanCheck = $toggles.OffLan

    $errorLabel = New-Label -Text '' -Size 9 -Color $ColBad
    $errorLabel.SetBounds(40, ($y + 70), 806, 18)

    $back = New-FlatButton -Text 'Back'
    $back.SetBounds(40, ($y + 92), 120, 38)
    $back.Add_Click($OnBack)

    $go = New-FlatButton -Text 'Set up my swarm' -Primary
    $go.SetBounds(172, ($y + 92), 200, 38)
    $go.Add_Click({
        $email = $emailBox.Text.Trim()
        if ($email -and -not (Test-EmailLike -Address $email)) {
            $errorLabel.Text = "'$email' does not look like an email address."
            return
        }
        $errorLabel.Text = ''
        & $OnContinue $devCheck.Checked ($offLanCheck.Enabled -and $offLanCheck.Checked) $email
    }.GetNewClosure())

    # $devCheck / $offLanCheck were already added by Add-SwarmToggles.
    $panel.Controls.AddRange(@($errorLabel, $back, $go))
    return $panel
}

<#
.SYNOPSIS The join-code entry panel shown before a node install.
.PARAMETER OnBack     Return to the chooser.
.PARAMETER OnContinue Invoked with (joinCode, withCliTools).
.OUTPUTS [System.Windows.Forms.Panel]
#>
function New-JoinPanel {
    param([scriptblock]$OnBack, [scriptblock]$OnContinue)
    $panel = New-Object Windows.Forms.Panel
    $panel.BackColor = $ColBg

    $heading = New-Label -Text 'Paste your join code' -Size 18 -Bold
    $heading.SetBounds(40, 28, 700, 34)
    $sub = New-Label -Text "The swarm printed it at the end of its install. For a fresh one, open /api/join/ on the swarm. It starts with OSJOIN." -Size 10 -Color $ColMuted
    $sub.SetBounds(40, 64, 806, 24)

    $box = New-Object Windows.Forms.TextBox
    $box.SetBounds(40, 106, 806, 30)
    $box.Font = New-Object Drawing.Font('Consolas', 11)
    $box.BackColor = $ColCard; $box.ForeColor = $ColFg
    $box.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle

    $cliCheck = New-Object Windows.Forms.CheckBox
    $cliCheck.SetBounds(40, 156, 806, 26)
    $cliCheck.Text = 'Also install the AI command-line tools (codex, claude, cline). Slower, but this node can do real work.'
    $cliCheck.Checked = $true
    $cliCheck.ForeColor = $ColMuted
    $cliCheck.Font = New-Object Drawing.Font('Segoe UI', 9)

    # Not $error -- that is an automatic variable holding the session's error log.
    $errorLabel = New-Label -Text '' -Size 9 -Color $ColBad
    $errorLabel.SetBounds(40, 190, 806, 22)

    $back = New-FlatButton -Text 'Back'
    $back.SetBounds(40, 232, 120, 38)
    $back.Add_Click($OnBack)

    $go = New-FlatButton -Text 'Join the swarm' -Primary
    $go.SetBounds(172, 232, 200, 38)
    $go.Add_Click({
        # OSJOIN1 = same network. OSJOIN2 = also carries tailnet credentials. Accept both.
        $code = $box.Text.Trim()
        if ($code.Replace(' ', '') -notmatch '^OSJOIN[12]\.') {
            $errorLabel.Text = "That does not look like a join code. It should start with OSJOIN1. or OSJOIN2."
            return
        }
        $errorLabel.Text = ''
        & $OnContinue $code $cliCheck.Checked
    }.GetNewClosure())

    $panel.Controls.AddRange(@($heading, $sub, $box, $cliCheck, $errorLabel, $back, $go))
    return $panel
}

<#
.SYNOPSIS The live-output panel: a log pane, a marquee bar, and a Cancel that really cancels.
.PARAMETER Title The step being run.
.OUTPUTS [hashtable] @{ Panel; Log; Bar; Button; Status }
#>
function New-RunPanel {
    param([string]$Title)
    $panel = New-Object Windows.Forms.Panel
    $panel.BackColor = $ColBg

    $heading = New-Label -Text $Title -Size 16 -Bold
    $heading.SetBounds(40, 24, 700, 30)

    $status = New-Label -Text 'Working. You can leave this window open.' -Size 9.5 -Color $ColMuted
    $status.SetBounds(40, 58, 780, 22)

    $bar = New-Object Windows.Forms.ProgressBar
    $bar.SetBounds(40, 88, 806, 6)
    $bar.Style = [Windows.Forms.ProgressBarStyle]::Marquee
    $bar.MarqueeAnimationSpeed = 30

    $log = New-Object Windows.Forms.RichTextBox
    $log.SetBounds(40, 110, 806, 250)
    $log.ReadOnly = $true
    $log.BackColor = [Drawing.Color]::FromArgb(18, 20, 24)
    $log.ForeColor = $ColMuted
    $log.BorderStyle = [Windows.Forms.BorderStyle]::None
    $log.Font = New-Object Drawing.Font('Consolas', 9)

    $button = New-FlatButton -Text 'Cancel'
    $button.SetBounds(40, 378, 160, 38)

    $panel.Controls.AddRange(@($heading, $status, $bar, $log, $button))
    return @{ Panel = $panel; Log = $log; Bar = $bar; Button = $button; Status = $status }
}

# ---------------------------------------------------------------------------
# Form
# ---------------------------------------------------------------------------

$form = New-Object Windows.Forms.Form
$form.Text = 'Open Swarm - Install'
$form.ClientSize = New-Object Drawing.Size(886, 486)
$form.StartPosition = 'CenterScreen'
$form.BackColor = $ColBg
$form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedSingle
$form.MaximizeBox = $false

$content = New-Object Windows.Forms.Panel
$content.Dock = [Windows.Forms.DockStyle]::Fill
$content.BackColor = $ColBg
$form.Controls.Add($content)

<#
.SYNOPSIS Runs an installer script, streaming it into a fresh run panel.
.DESCRIPTION The drain timer is created per invocation: reusing one form-level timer would
stack a second Tick handler on a re-run and double-drain the queue.
.PARAMETER Title      Panel heading.
.PARAMETER ScriptName Script under installer/lib.
.PARAMETER Arguments  Extra argv.
.PARAMETER DoneText   Heading shown on success.
#>
function Invoke-Role {
    param([string]$Title, [string]$ScriptName, [string[]]$Arguments, [string]$DoneText)
    $run = New-RunPanel -Title $Title
    Show-Panel -Container $content -Panel $run.Panel

    $script:Results = @{}
    $script:LogQueue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
    $script:Proc = Start-InstallerChild -ScriptName $ScriptName -Arguments $Arguments

    $run.Button.Add_Click({
        if ($script:Proc -and -not $script:Proc.HasExited) { $script:Proc.Kill() } else { $form.Close() }
    }.GetNewClosure())

    $timer = New-Object Windows.Forms.Timer
    $timer.Interval = 120

    $onFinish = {
        param([int]$code)
        $timer.Stop()
        $run.Bar.Style = [Windows.Forms.ProgressBarStyle]::Continuous
        $run.Button.Text = 'Close'
        if ($code -eq 0) {
            $run.Bar.Value = 100
            $run.Status.Text = $DoneText
            $run.Status.ForeColor = $ColGood
            Add-SuccessActions -Panel $run.Panel
        } else {
            # Leave the bar empty. Visual styles ignore ForeColor, so a full green bar
            # over a red error message is the one thing that must not happen here.
            $run.Bar.Value = 0
            $run.Status.Text = 'Did not finish. The last red line above says why.'
            $run.Status.ForeColor = $ColBad
        }
    }.GetNewClosure()

    $timer.Add_Tick({ Update-LogPane -Box $run.Log -OnFinish $onFinish }.GetNewClosure())
    $timer.Start()
}

<#
.SYNOPSIS Adds the post-success controls: open the cockpit, copy the join code.
.DESCRIPTION The join code is the whole point of the swarm install -- it is what the human
carries to the next machine -- so it gets a copy button rather than a line they must select.
.PARAMETER Panel The run panel to decorate.
#>
function Add-SuccessActions {
    param([Windows.Forms.Panel]$Panel)
    if ($script:Results.ContainsKey('COCKPIT')) {
        $url = $script:Results['COCKPIT']
        $open = New-FlatButton -Text 'Open the cockpit' -Primary
        $open.SetBounds(212, 378, 190, 38)
        $open.Add_Click({ Start-Process $url }.GetNewClosure())
        $Panel.Controls.Add($open)
    }
    if ($script:Results.ContainsKey('JOINCODE')) {
        $code = $script:Results['JOINCODE']
        $copy = New-FlatButton -Text 'Copy join code'
        $copy.SetBounds(414, 378, 190, 38)
        $copy.Add_Click({
            [Windows.Forms.Clipboard]::SetText($code)
            $this.Text = 'Copied!'
        }.GetNewClosure())
        $Panel.Controls.Add($copy)

        $hint = New-Label -Text "Paste it on your other computers." -Size 9 -Color $ColMuted
        $hint.SetBounds(616, 388, 230, 20)
        $Panel.Controls.Add($hint)
    }
}

# Panel wiring. The forward references ($showOptions, $joinNode) resolve when the click
# fires, not when the scriptblock is defined.
$showChooser = {
    $chooser = New-ChooserPanel `
        -OnSwarm { Show-Panel -Container $content -Panel (New-SwarmOptionsPanel -OnBack $showChooser -OnContinue $runSwarm) } `
        -OnNode  { Show-Panel -Container $content -Panel (New-JoinPanel -OnBack $showChooser -OnContinue $joinNode) }
    Show-Panel -Container $content -Panel $chooser
}

$runSwarm = {
    param([bool]$devMode, [bool]$offLan, [string]$operatorEmail)
    # -NonInteractive: the child must never Read-Host. The panel above already asked everything.
    $swarmArgs = @('-NonInteractive')
    if ($devMode) { $swarmArgs += '-Dev' }
    if ($offLan)  { $swarmArgs += '-OffLan' }
    if ($operatorEmail) { $swarmArgs += @('-OperatorEmail', $operatorEmail) }
    Invoke-Role -Title 'Setting up your swarm' -ScriptName 'install-swarm.ps1' -Arguments $swarmArgs -DoneText 'Your swarm is running.'
}

$joinNode = {
    param([string]$code, [bool]$withClis)
    $joinArgs = @('-JoinCode', $code)
    if ($withClis) { $joinArgs += '-WithCliTools' }
    Invoke-Role -Title 'Joining the swarm' -ScriptName 'install-node.ps1' -Arguments $joinArgs -DoneText 'This computer is now a worker node.'
}

& $showChooser
[void]$form.ShowDialog()
