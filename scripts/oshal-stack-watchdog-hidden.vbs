' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for oshal-stack-watchdog.ps1 (mirrors trading-watchdog-hidden.vbs). A bare powershell scheduled action flashes a console every 5 minutes and steals focus from desktop automation; wscript Run(..., 0, False) starts it with no window at all (even -WindowStyle Hidden flashes the console host first).
' 2 | maintainer@emeraldcoastsystemsgroup.com   | Self-locating (ADR-115 trunk cutover): launch the ps1 sitting NEXT TO this launcher instead of a hardcoded checkout path, so the pair works from any checkout and survives trunk moves.
' =============================================================================
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\oshal-stack-watchdog.ps1""", 0, False
