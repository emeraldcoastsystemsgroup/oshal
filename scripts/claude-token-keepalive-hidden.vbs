' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the 2-hourly "OSHAL Claude token keepalive" task (same zero-window pattern as trading-watchdog-hidden.vbs). The task ran powershell -WindowStyle Hidden directly, which still flashes the console host before it hides - the operator saw a DOS popup every 2 hours. wscript Run(..., 0, False) starts it with no window at all.
' =============================================================================
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Projects\open-shal-swarm-harness-agent-llm\scripts\claude-token-keepalive.ps1""", 0, False
