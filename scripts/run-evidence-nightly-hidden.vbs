' =============================================================================
' CHANGE LOG
' -----------------------------------------------------------------------------
' SEQ                 | AUTHOR                      | DESCRIPTION
' -----------------------------------------------------------------------------
' 1 | maintainer@emeraldcoastsystemsgroup.com   | Windowless launcher for the 3:30AM "OSHAL-Evidence-Nightly" task (zero-window pattern; bare powershell flashes the console host).
' 2 | maintainer@emeraldcoastsystemsgroup.com   | Declare the hardcoded checkout DELIBERATE and machine-readable. Every other launcher here was made self-locating so no scheduled task can drift onto the frozen ADR-115 archive; this one must NOT be, because the job writes its board to docs/evidence/ - internal-only, refused by the publish gate, and absent from this public trunk by design. Without the marker the next sweep "fixes" this file and the nightly starts writing an evidence board into a tree that cannot hold one. See docs/runbooks/scheduled-tasks-trunk-vs-archive.md.
' =============================================================================
' OSHAL-INTENTIONAL-ARCHIVE-PATH: this launcher runs the PRIVATE archive checkout on purpose.
' The evidence board lives at docs/evidence/, which exists only in the private reference archive
' (emeraldcoastsystemsgroup/open-shal). Do not make this self-locating without first relocating
' the board. ASCII-only on purpose (a non-ASCII launcher fails silently under wscript //B).
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Projects\open-shal-swarm-harness-agent-llm\scripts\run-evidence-nightly.ps1""", 0, False
