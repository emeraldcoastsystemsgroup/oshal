# Node-side daily trade-recap AGENT launcher. Runs ON the video PC (repo + a debug Chrome
# logged into Google Vids + a signed-in agent CLI). Started DETACHED by the in-container
# dispatcher (oshal-recap-agent-remote.js) so it is NOT bound by the node's 120s shell.exec
# cap. Unlike recap-render-node.ps1 (a rigid make-trade-report build), this launches the
# LOCAL AGENT (claude/codex CLI) with the recap GOAL + the SOP; the agent drives Vids itself,
# adapts, and writes recap-agent.done / .err per packages\oshal-vids-operator\RECAP-SOP.md.
#
# This launcher only: clears sentinels, picks the signed-in CLI, pipes it the prompt, and —
# if the agent exits WITHOUT a sentinel — writes a FALLBACK .err with the log tail so the
# dispatcher never hangs and never sees a fake success.
$ErrorActionPreference = 'Stop'
$root = 'C:\Projects\open-shal-swarm-harness-agent-llm'
$out  = Join-Path $root 'packages\oshal-vids-operator\out'
$done = Join-Path $out 'recap-agent.done'
$err  = Join-Path $out 'recap-agent.err'
$log  = Join-Path $out 'recap-agent.log'
$promptFile = Join-Path $out 'recap-agent.prompt.txt'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Force -Path $out | Out-Null }
Remove-Item $done, $err -ErrorAction SilentlyContinue
try {
  if (-not (Test-Path $promptFile)) { throw "prompt file missing: $promptFile" }
  $prompt = Get-Content $promptFile -Raw

  # Pick the signed-in agent CLI. Prefer claude for this screenshot-driving, long-horizon
  # agentic task (it is Claude-Code-shaped work); override with env RECAP_AGENT_CLI=codex.
  # Auth check mirrors the node's swarm.exec (~/.claude/.credentials.json | ~/.codex/auth.json).
  $profileDir = $env:USERPROFILE
  $claudeAuthed = Test-Path (Join-Path $profileDir '.claude\.credentials.json')
  $codexAuthed  = Test-Path (Join-Path $profileDir '.codex\auth.json')
  $want = $env:RECAP_AGENT_CLI
  $cli = $null; $cliArgs = @()
  # Full access on BOTH: this is the operator's own box running a trusted multi-step job that
  # writes the out dir + both site repos and runs git/wrangler/CDP — the default workspace-write
  # sandbox denies those (proven by the plumbing self-test). claude: --dangerously-skip-permissions;
  # codex: -s danger-full-access. Same trust posture, just the two CLIs' spellings of it.
  $claudeArgs = @('-p','--output-format','json','--dangerously-skip-permissions','--no-session-persistence')
  $codexArgs  = @('exec','--json','--skip-git-repo-check','-s','danger-full-access','-C',$root)
  if ($want -eq 'codex' -and $codexAuthed)      { $cli = 'codex';  $cliArgs = $codexArgs }
  elseif ($want -eq 'claude' -and $claudeAuthed) { $cli = 'claude'; $cliArgs = $claudeArgs }
  elseif ($claudeAuthed)                         { $cli = 'claude'; $cliArgs = $claudeArgs }
  elseif ($codexAuthed)                          { $cli = 'codex';  $cliArgs = $codexArgs }
  else { throw 'no local agent CLI is signed in (claude or codex). Sign in via the OSHAL client Config.' }

  Set-Location $root
  ("[{0}] recap agent launching: {1} {2}" -f (Get-Date -Format s), $cli, ($cliArgs -join ' ')) | Out-File $log -Encoding utf8
  # Pipe the prompt over stdin (avoids arg-length limits); tee all streams to the log so the
  # run is monitorable. The agent runs autonomously and writes the sentinel itself.
  $prompt | & $cli @cliArgs *>> $log
  $exit = $LASTEXITCODE

  if (-not (Test-Path $done) -and -not (Test-Path $err)) {
    $tail = if (Test-Path $log) { (Get-Content $log -Tail 60 -Raw) } else { '' }
    ("agent exited (code $exit) without writing a sentinel. log tail:`n" + $tail) | Out-File $err -Encoding utf8
  }
} catch {
  ($_.Exception.Message) | Out-File $err -Encoding utf8
}
