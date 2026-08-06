' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the daily "OSHAL Local CI" scheduled task (same zero-window pattern as trading-watchdog-hidden.vbs). Runs scripts/ci-local.sh --scheduled via Git Bash; output goes to %LOCALAPPDATA%\oshal\ci-local-last-run.log.
' 2 | maintainer@emeraldcoastsystemsgroup.com   | Derive the repo from this script's OWN location instead of hardcoding it. The hardcoded path meant the nightly gate kept judging whichever clone the task was first registered against — after the ADR-115 trunk cutover that is the ARCHIVE, and a gate that stays green forever on a repo nobody commits to is worse than no gate.
' 3 | maintainer@emeraldcoastsystemsgroup.com   | Wait for ci-local.sh and propagate its real exit code so Task Scheduler cannot report success while the gate is still running or has failed.
' =============================================================================
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = Replace(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)), "\", "/")
command = """C:\Program Files\Git\bin\bash.exe"" """ & repo & "/scripts/ci-local.sh"" --scheduled"
exitCode = sh.Run(command, 0, True)
WScript.Quit exitCode
