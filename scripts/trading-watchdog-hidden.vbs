' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Hidden launcher for trading-watchdog.ps1. The scheduled task ran powershell in a visible console every 10 minutes, flashing a window that stole focus from desktop automation. wscript Run(..., 0, False) starts it with no window at all (a bare -WindowStyle Hidden still flashes the console host before it hides).
' 2 | maintainer@emeraldcoastsystemsgroup.com   | Self-locating (ADR-115 trunk cutover): launch the ps1 sitting NEXT TO this launcher instead of a hardcoded checkout path, so the pair works from any checkout and survives trunk moves.
' =============================================================================
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\trading-watchdog.ps1""", 0, False
