' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the 4:30PM "OSHAL Signal Labeler" task - the task ran the .cmd DIRECTLY, which opens a full visible console window. wscript Run(..., 0, False) runs it with no window.
' =============================================================================
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Projects\open-shal-swarm-harness-agent-llm\scripts\oshal-signal-daily.cmd""", 0, False
