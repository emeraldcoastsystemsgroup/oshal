# AnimateDiff-Evolved cloned but its node types didn't register — it needs its Python deps
# installed into ComfyUI's embedded python (a raw git clone doesn't do that). Install them,
# then restart ComfyUI so the node loads. Logs to ad-deps.log.
$ErrorActionPreference = 'Continue'
$port = "$env:USERPROFILE\oshal-comfyui\ComfyUI_windows_portable"
$py = "$port\python_embeded\python.exe"
$node = "$port\ComfyUI\custom_nodes\ComfyUI-AnimateDiff-Evolved"
$log = "$env:USERPROFILE\ad-deps.log"
function L($m) { ("[{0}] {1}" -f (Get-Date -Format HH:mm:ss), $m) | Tee-Object -FilePath $log -Append }

L "py=$(Test-Path $py) node=$(Test-Path $node)"
if (Test-Path "$node\requirements.txt") {
  L "pip install -r requirements.txt"
  & $py -s -m pip install -r "$node\requirements.txt" *>> $log 2>&1
  L "pip exit=$LASTEXITCODE"
} else {
  L "no requirements.txt (deps may be bundled) — restarting anyway"
}
L "restarting ComfyUI"
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like '*oshal-comfyui*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Start-Sleep -Seconds 2
Start-Process -FilePath "$env:USERPROFILE\oshal-comfyui\start-comfyui.bat" -WindowStyle Minimized
L "done"
