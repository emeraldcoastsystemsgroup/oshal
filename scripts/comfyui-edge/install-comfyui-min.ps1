# Minimal, robust ComfyUI installer for the OSHAL edge node (Windows + NVIDIA).
# Best-effort (does not die on the first error), logs to comfyui-install.log, runs
# the heavy download via curl.exe + extracts the portable .7z with 7zr, then starts
# ComfyUI listening on the LAN (0.0.0.0:8188). Shipped to the node + launched detached.
$ErrorActionPreference = 'Continue'
$R = "$env:USERPROFILE\oshal-comfyui"
New-Item -ItemType Directory -Force $R | Out-Null
$log = "$env:USERPROFILE\comfyui-install.log"
function Log($m) { ("[{0}] {1}" -f (Get-Date -Format HH:mm:ss), $m) | Tee-Object -FilePath $log -Append }

Log "start; root=$R"
$cd = "$R\ComfyUI_windows_portable"
$arc = "$R\comfyui.7z"
if (-not (Test-Path $cd)) {
  if (-not (Test-Path $arc) -or (Get-Item $arc).Length -lt 100MB) {
    Log "downloading ComfyUI portable (~1.5GB) via curl"
    curl.exe -L --fail -o $arc "https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z"
    Log "download exit=$LASTEXITCODE size=$([int]((Get-Item $arc -EA SilentlyContinue).Length/1MB))MB"
  }
  $z = "$R\7zr.exe"
  if (-not (Test-Path $z)) { curl.exe -L --fail -o $z "https://www.7-zip.org/a/7zr.exe"; Log "7zr exit=$LASTEXITCODE" }
  Log "extracting"
  & $z x $arc "-o$R" -y | Out-Null
  Log "extract exit=$LASTEXITCODE extracted=$(Test-Path $cd)"
}

if (Test-Path $cd) {
  $bat = "$R\start-comfyui.bat"
  "@echo off`r`ncd /d `"$cd`"`r`n.\python_embeded\python.exe -s ComfyUI\main.py --listen 0.0.0.0 --port 8188" | Set-Content -Encoding ascii $bat
  # auto-start at login
  $lnk = (Join-Path ([Environment]::GetFolderPath('Startup')) 'OSHAL-ComfyUI.lnk')
  $ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut($lnk); $sc.TargetPath = $bat; $sc.WindowStyle = 7; $sc.Save()
  Log "launching comfyui on 0.0.0.0:8188"
  Start-Process -FilePath $bat -WindowStyle Minimized
  Start-Sleep -Seconds 8
  $up = (Test-NetConnection localhost -Port 8188 -InformationLevel Quiet)
  Log "DONE; port8188=$up"
} else {
  Log "FAILED: ComfyUI not extracted"
}
