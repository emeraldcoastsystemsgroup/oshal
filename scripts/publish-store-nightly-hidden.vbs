' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the OSHAL-Store-Publish task. SELF-LOCATING on purpose (publish-lab-report-hidden.vbs pattern, ADR-115): it runs the .ps1 sitting NEXT TO it, never a hardcoded checkout. The sibling launcher run-evidence-nightly-hidden.vbs hardcodes the frozen archive path, which is exactly how a step added to the trunk copy of a nightly script silently never runs.
' =============================================================================
' A bare powershell scheduled action pops a visible console every run; wscript //B hides it.
' ASCII-only on purpose.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\publish-store-nightly.ps1""", 0, False
