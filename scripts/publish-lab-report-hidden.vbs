' Hidden launcher for publish-lab-report.ps1 (a bare powershell scheduled action pops a visible
' console every run - same pattern as trading-watchdog-hidden.vbs). ASCII-only on purpose.
' Self-locating (ADR-115): launch the ps1 sitting NEXT TO this launcher, never a hardcoded checkout.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\publish-lab-report.ps1""", 0, False
