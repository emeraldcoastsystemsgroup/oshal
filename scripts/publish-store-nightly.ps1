<#
  publish-store-nightly.ps1 -- Task Scheduler wrapper for the public app-store refresh.

  WHY IT IS ITS OWN TASK, and not a step in the evidence nightly:
    The obvious home was run-evidence-nightly.ps1, and that is where this started. It does not
    work. OSHAL-Evidence-Nightly's scheduled action executes
    C:\Projects\open-shal-swarm-harness-agent-llm\scripts\run-evidence-nightly-hidden.vbs -- the
    FROZEN ADR-115 reference archive -- and the trunk's own copy of that .vbs hardcodes the same
    archive path, so even repointing the task would still run archive code. A publish step added
    to the trunk copy is a step that never executes. (BACKLOG "Nightly scheduled tasks still
    launch from the frozen archive repo"; Evidence-Nightly is documented there as unable to move,
    because it writes its board to docs/evidence/, which is internal-only and absent from the
    public trunk by design.)

    So the store publish gets its own trunk-resident task with a SELF-LOCATING launcher (the
    publish-lab-report-hidden.vbs pattern): the .vbs runs the .ps1 sitting next to it, so the task
    can never silently drift back to another checkout.

  WHAT IT DOES:
    Runs scripts/publish-store.sh in the oshal-applications checkout. That script cuts the public
    snapshot from origin/main in a throwaway clone (a dirty shared tree is irrelevant), runs four
    content gates plus a gitleaks scan, and pushes ONE gated commit to the public store. It exits
    0 without committing when the cut is identical to what is already live, so a quiet night
    produces no commit at all.

  WHY IT NEEDS THIS BOX: the gitleaks gate runs in Docker, and the push uses the operator's git
  credential helper. Neither exists on a GitHub runner, which is why this is not an Action.

  NOTE: keep this file pure ASCII. PowerShell 5.1 reads BOM-less .ps1 as ANSI, and UTF-8 em-dash
  bytes decode to a CP-1252 curly quote that terminates strings early (parse error).

  Scheduled by scripts/register-store-publish-nightly.ps1 (task 'OSHAL-Store-Publish').
  Run manually:  powershell -ExecutionPolicy Bypass -File scripts/publish-store-nightly.ps1
  Dry run:       powershell -ExecutionPolicy Bypass -File scripts/publish-store-nightly.ps1 -DryRun

  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Replace the copied, unbounded Bash lookup with the shared bounded Git for Windows resolver and abort loudly when no validated shell exists.
#>
param(
  # Cut and diff against what is live, but do not push. Safe to run any time.
  [switch]$DryRun
)

# NOT 'Stop': native commands write progress to stderr, which PowerShell 5.1 under Stop turns into
# a terminating NativeCommandError. Real failure is gated on the script's exit code.
$ErrorActionPreference = 'Continue'

$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $repo 'logs\store-publish'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$log = Join-Path $logDir ((Get-Date -Format 'yyyy-MM-dd') + '.log')

function Note($m) { ("[{0}] {1}" -f (Get-Date -Format s), $m) | Out-File $log -Append -Encoding utf8 }

Note "=== store publish starting (launcher repo $repo) ==="

# Never use bare `bash` here: Task Scheduler resolves it to C:\Windows\System32\bash.exe, the WSL
# launcher that caused the first store run to fail at `set -o pipefail`. WSL also exposes /mnt/c
# instead of Git Bash's Windows tool view. The shared helper requires BASH_VERSION plus an
# MSYS/MINGW runtime signature within a finite timeout and returns null rather than guessing.
$bashResolver = Join-Path $PSScriptRoot 'lib\windows-git-bash.ps1'
if (-not (Test-Path -LiteralPath $bashResolver -PathType Leaf)) {
  Note "Git Bash resolver missing at $bashResolver - ABORTING"
  exit 2
}
try { . $bashResolver }
catch { Note "Git Bash resolver failed to load: $($_.Exception.Message) - ABORTING"; exit 2 }
if ($null -eq (Get-Command Resolve-OshalGitBash -CommandType Function -ErrorAction SilentlyContinue)) {
  Note "Git Bash resolver did not define Resolve-OshalGitBash - ABORTING"
  exit 2
}
$bash = Resolve-OshalGitBash
if (-not $bash) {
  Note "no validated Git Bash found - ABORTING rather than falling back to System32/WSL bash"
  exit 2
}
Note "bash: $bash (validated with bounded MSYS/MINGW identity probe)"

# Resolve the store checkout the same way scripts/app-store-drift-check.sh does: env override,
# sibling of this repo, then the known dev-host path.
$storeDir = $env:OSHAL_STORE_DIR
if (-not $storeDir) {
  $sibling = Join-Path (Split-Path -Parent $repo) 'oshal-applications'
  if (Test-Path (Join-Path $sibling 'marketplace.json')) { $storeDir = $sibling }
  elseif (Test-Path 'C:\Projects\oshal-applications\marketplace.json') { $storeDir = 'C:\Projects\oshal-applications' }
}
if (-not $storeDir) {
  Note "no store checkout found - ABORTING (set OSHAL_STORE_DIR)"
  exit 2
}
$publisher = Join-Path $storeDir 'scripts\publish-store.sh'
if (-not (Test-Path $publisher)) {
  Note "store checkout $storeDir has no scripts/publish-store.sh - ABORTING"
  exit 2
}
Note "store checkout: $storeDir"

# Preflight: the gitleaks gate runs in a container, and this box's Docker Desktop engine has been
# seen hung (vmmemWSL CPU flat, /info returning 500) while the CLI still answers. Note it either
# way and proceed: publish-store.sh is fail-closed and will refuse rather than ship an unscanned
# cut, which is the outcome we want recorded honestly.
$dockerOk = $false
try {
  $null = & docker version --format '{{.Server.Version}}' 2>$null
  if ($LASTEXITCODE -eq 0) { $dockerOk = $true }
} catch { Note "preflight: docker probe raised an error: $($_.Exception.Message)" }
if ($dockerOk) { Note "preflight: docker engine responding" }
else { Note "preflight: docker engine NOT responding - the gitleaks gate will refuse and this run will fail honestly (recover with scripts/oshal-up.sh)" }

$flag = ''
if ($DryRun) { $flag = ' --dry-run'; Note "mode: DRY RUN (no push)" }

Push-Location $storeDir
# cmd /c so native stdout+stderr land in the log without PS 5.1 ErrorRecord wrapping. The bash
# path is quoted because it lives under "Program Files".
cmd /c "`"$bash`" scripts/publish-store.sh$flag >> `"$log`" 2>&1"
$exit = $LASTEXITCODE
Pop-Location

if ($exit -eq 0) { Note "=== store publish finished OK (exit 0) ===" }
else { Note "=== store publish FAILED (exit $exit) - THE PUBLIC STORE IS NOW STALE; see the output above ===" }

# Keep the last 14 logs, same retention as the evidence nightly.
Get-ChildItem $logDir -Filter '*.log' | Sort-Object Name -Descending | Select-Object -Skip 14 |
  ForEach-Object {
    $oldLog = $_.FullName
    try { Remove-Item $oldLog -Force -Confirm:$false -ErrorAction Stop }
    catch { Note ("retention: could not remove {0}: {1}" -f $oldLog, $_.Exception.Message) }
  }

exit $exit
