' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the 4:30PM "OSHAL Signal Labeler" task - the task ran the .cmd DIRECTLY, which opens a full visible console window. wscript Run(..., 0, False) runs it with no window.
' 2 | maintainer@emeraldcoastsystemsgroup.com   | SELF-LOCATING (ADR-115, publish-store-nightly-hidden.vbs pattern). SEQ 1 hardcoded the pre-cutover archive checkout, so the labeler ran that tree's oshal-signal-label.js - which has since diverged from the trunk by hundreds of lines and never received a single post-cutover fix. Launch the .cmd sitting NEXT TO this launcher instead.
' =============================================================================
' ASCII-only on purpose (a non-ASCII launcher fails silently under wscript //B).
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & scriptDir & "\oshal-signal-daily.cmd""", 0, False
