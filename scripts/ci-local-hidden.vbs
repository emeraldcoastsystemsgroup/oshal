' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the daily "OSHAL Local CI" scheduled task (same zero-window pattern as trading-watchdog-hidden.vbs). Runs scripts/ci-local.sh --scheduled via Git Bash; output goes to %LOCALAPPDATA%\oshal\ci-local-last-run.log.
' =============================================================================
' 2 | maintainer@emeraldcoastsystemsgroup.com   | Derive the repo from this script's OWN location instead of hardcoding it. The hardcoded path meant the nightly gate kept judging whichever clone the task was first registered against — after the ADR-115 trunk cutover that is the ARCHIVE, and a gate that stays green forever on a repo nobody commits to is worse than no gate.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = Replace(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)), "\", "/")
sh.Run """C:\Program Files\Git\bin\bash.exe"" """ & repo & "/scripts/ci-local.sh"" --scheduled", 0, False
