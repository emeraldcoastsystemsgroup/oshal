' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the "OSHAL Monitoring Liveness" scheduled task (same pattern as ci-local-hidden.vbs). Runs scripts/monitoring-liveness-watch.sh through Git Bash with no console window - a bare bash action flashes a window every few minutes and steals focus from desktop automation. Self-locating: the repo is derived from THIS file's own location, never a hardcoded checkout, so the task cannot end up judging the ADR-115 archive the way the nightly launchers did. Waits for the watch and propagates its exit code so Task Scheduler's Last Result is the strict check's real answer.
' =============================================================================
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = Replace(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)), "\", "/")
command = """C:\Program Files\Git\bin\bash.exe"" """ & repo & "/scripts/monitoring-liveness-watch.sh"""
exitCode = sh.Run(command, 0, True)
WScript.Quit exitCode
