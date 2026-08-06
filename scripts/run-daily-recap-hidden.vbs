' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the 5PM "OSHAL Daily Trade Recap" task (zero-window pattern; bare powershell flashes the console host).
' 2 | maintainer@emeraldcoastsystemsgroup.com   | Wait for the recap process and propagate its exit code. Fire-and-forget made Task Scheduler report 0x0 at launch even when the recap later failed, masking missed publishes.
' =============================================================================
' Self-locating (ADR-115 pattern, same as publish-lab-report-hidden.vbs): launch the ps1 sitting
' NEXT TO this launcher, never a hardcoded checkout — a hardcoded path silently pins the scheduled
' task to a stale tree after a cutover.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
exitCode = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\run-daily-recap.ps1""", 0, True)
WScript.Quit exitCode
