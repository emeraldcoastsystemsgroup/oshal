' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the 2-hourly "OSHAL Claude token keepalive" task (same zero-window pattern as trading-watchdog-hidden.vbs). The task ran powershell -WindowStyle Hidden directly, which still flashes the console host before it hides - the operator saw a DOS popup every 2 hours. wscript Run(..., 0, False) starts it with no window at all.
' 2 | maintainer@emeraldcoastsystemsgroup.com   | SELF-LOCATING (ADR-115, publish-store-nightly-hidden.vbs pattern). SEQ 1 hardcoded the pre-cutover archive checkout, which pinned the 2-hourly task to a tree frozen at the cutover commit. The trunk copy differs only in its Change Log header today (a renamed column and an author-email rewrite, no behavioural difference) and the task has been refreshing successfully throughout - what was wrong was the pin to a frozen checkout, not the behaviour it ran.
' =============================================================================
' ASCII-only on purpose (a non-ASCII launcher fails silently under wscript //B).
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\claude-token-keepalive.ps1""", 0, False
