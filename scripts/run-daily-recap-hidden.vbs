' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the 5PM "OSHAL Daily Trade Recap" task (zero-window pattern; bare powershell flashes the console host).
' =============================================================================
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Projects\open-shal-swarm-harness-agent-llm\scripts\run-daily-recap.ps1""", 0, False
