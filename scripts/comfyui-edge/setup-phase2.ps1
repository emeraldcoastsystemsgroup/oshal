# Phase 2 on the OSHAL edge node: install the claude-code agent CLI (so the box can
# self-drive finicky installs) + ComfyUI-Manager (so models/nodes are self-service).
# Best-effort, logs to setup-phase2.log. Shipped + launched detached by the swarm.
$ErrorActionPreference = 'Continue'
$log = "$env:USERPROFILE\setup-phase2.log"
function L($m) { ("[{0}] {1}" -f (Get-Date -Format HH:mm:ss), $m) | Tee-Object -FilePath $log -Append }

L "phase2 start"
L "installing claude-code (npm i -g @anthropic-ai/claude-code@latest)"
& npm install -g @anthropic-ai/claude-code@latest *>> $log 2>&1
L ("claude=" + (Get-Command claude -ErrorAction SilentlyContinue).Source)

$git = "C:\Program Files\Git\cmd\git.exe"
$cn = "$env:USERPROFILE\oshal-comfyui\ComfyUI_windows_portable\ComfyUI\custom_nodes"
if (Test-Path $cn) {
  if (-not (Test-Path "$cn\ComfyUI-Manager")) {
    L "cloning ComfyUI-Manager"
    & $git clone --depth 1 https://github.com/ltdrdata/ComfyUI-Manager "$cn\ComfyUI-Manager" *>> $log 2>&1
  }
  L ("manager=" + (Test-Path "$cn\ComfyUI-Manager"))
} else {
  L "custom_nodes not found at $cn"
}
L "phase2 done"
