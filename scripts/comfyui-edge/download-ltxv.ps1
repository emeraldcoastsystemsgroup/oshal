# Download the LTX-Video native t2v models into ComfyUI (exact filenames from the HF API):
# the 8GB-friendly LTXV 2B v0.9.5 checkpoint + the t5xxl fp8 text encoder. No custom node needed
# (ComfyUI 0.26 has native LTXV nodes). Best-effort, logs to ltxv-dl.log. Run detached.
$ErrorActionPreference = 'Continue'
$base = "$env:USERPROFILE\oshal-comfyui\ComfyUI_windows_portable\ComfyUI"
$log = "$env:USERPROFILE\ltxv-dl.log"
function L($m) { ("[{0}] {1}" -f (Get-Date -Format HH:mm:ss), $m) | Tee-Object -FilePath $log -Append }

$ckptDir = "$base\models\checkpoints"
$teDir = "$base\models\text_encoders"
New-Item -ItemType Directory -Force $teDir | Out-Null

$m = "$ckptDir\ltx-video-2b-v0.9.5.safetensors"
if (-not (Test-Path $m) -or (Get-Item $m).Length -lt 100MB) {
  L "downloading LTXV 2B model (~6GB)"
  curl.exe -L --fail -o $m "https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors"
  L "ltxv exit=$LASTEXITCODE size=$([int]((Get-Item $m -EA SilentlyContinue).Length/1MB))MB"
}
$t = "$teDir\t5xxl_fp8_e4m3fn_scaled.safetensors"
if (-not (Test-Path $t) -or (Get-Item $t).Length -lt 100MB) {
  L "downloading t5xxl fp8 (~5GB)"
  curl.exe -L --fail -o $t "https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors"
  L "t5 exit=$LASTEXITCODE size=$([int]((Get-Item $t -EA SilentlyContinue).Length/1MB))MB"
}
L "done"
