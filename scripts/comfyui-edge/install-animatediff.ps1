# Install an 8GB-friendly text-to-video stack into the edge node's ComfyUI: SD1.5 base
# checkpoint + AnimateDiff-Evolved node + the v1.5 motion module, then restart ComfyUI so
# the node loads. Best-effort, logs to animatediff-install.log. Run detached by the swarm.
$ErrorActionPreference = 'Continue'
$base = "$env:USERPROFILE\oshal-comfyui\ComfyUI_windows_portable\ComfyUI"
$log = "$env:USERPROFILE\animatediff-install.log"
function L($m) { ("[{0}] {1}" -f (Get-Date -Format HH:mm:ss), $m) | Tee-Object -FilePath $log -Append }
$git = "C:\Program Files\Git\cmd\git.exe"
L "start; base=$base; baseExists=$(Test-Path $base)"

# 1) SD1.5 base checkpoint (~2GB) via the Comfy-Org mirror (no auth)
$ckpt = "$base\models\checkpoints\v1-5-pruned-emaonly-fp16.safetensors"
if (-not (Test-Path $ckpt) -or (Get-Item $ckpt).Length -lt 100MB) {
  L "downloading SD1.5 checkpoint"
  curl.exe -L --fail -o $ckpt "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors"
  L "sd15 exit=$LASTEXITCODE size=$([int]((Get-Item $ckpt -EA SilentlyContinue).Length/1MB))MB"
}

# 2) AnimateDiff-Evolved custom node
$node = "$base\custom_nodes\ComfyUI-AnimateDiff-Evolved"
if (-not (Test-Path $node)) {
  L "cloning AnimateDiff-Evolved"
  & $git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved $node *>> $log 2>&1
}
L "node=$(Test-Path $node)"

# 3) Motion module (~1.6GB) into the AnimateDiff models dir
$mmDir = "$base\models\animatediff_models"; New-Item -ItemType Directory -Force $mmDir | Out-Null
$mm = "$mmDir\mm_sd_v15_v2.ckpt"
if (-not (Test-Path $mm) -or (Get-Item $mm).Length -lt 100MB) {
  L "downloading motion module"
  curl.exe -L --fail -o $mm "https://huggingface.co/guoyww/animatediff/resolve/main/mm_sd_v15_v2.ckpt"
  L "mm exit=$LASTEXITCODE size=$([int]((Get-Item $mm -EA SilentlyContinue).Length/1MB))MB"
}

# 4) restart ComfyUI so the new custom node registers
L "restarting ComfyUI to load AnimateDiff"
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like '*oshal-comfyui*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Start-Sleep -Seconds 2
Start-Process -FilePath "$env:USERPROFILE\oshal-comfyui\start-comfyui.bat" -WindowStyle Minimized
L "done; comfyui restarted"
