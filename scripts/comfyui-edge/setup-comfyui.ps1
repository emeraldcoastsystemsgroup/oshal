# =============================================================================
# OSHAL ComfyUI edge-node bootstrap (Windows)
# -----------------------------------------------------------------------------
# One-time setup to turn a GPU box (e.g. the household "beefy box") into a FREE
# video-generation node for the OSHAL Video Studio (ADR-070). It:
#   1. detects the GPU,
#   2. downloads + extracts the official ComfyUI Windows portable build,
#   3. installs ComfyUI-Manager (so models/workflows are one click),
#   4. writes a start script that listens on the network (--listen 0.0.0.0:8188)
#      and an auto-start shortcut,
#   5. ensures Tailscale (so OSHAL can reach it privately), and
#   6. prints the Tailscale URL to hand back to OSHAL.
#
# This installs FREE software only. No OSHAL secrets, no remote-control agent —
# ComfyUI just listens on :8188 and OSHAL calls it like any provider.
#
# Run (from an elevated PowerShell on the GPU box):
#   powershell -ExecutionPolicy Bypass -File scripts\comfyui-edge\setup-comfyui.ps1
#
# CHANGE LOG
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ComfyUI edge-node bootstrap.
# =============================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # faster Invoke-WebRequest

$Root = "$env:USERPROFILE\oshal-comfyui"
$PortableUrl = 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z'
$SevenZrUrl = 'https://www.7-zip.org/a/7zr.exe'
$TailscaleUrl = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe'
$Port = 8188

function Say($m) { Write-Host "[oshal-comfyui] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[oshal-comfyui] $m" -ForegroundColor Yellow }

# --- 1. GPU detection -------------------------------------------------------
$gpus = (Get-CimInstance Win32_VideoController).Name
$gpuList = $gpus -join ', '
$isNvidia = [bool]($gpus | Where-Object { $_ -match 'NVIDIA' })
Say "GPU(s): $gpuList"
if ($isNvidia) { Say 'NVIDIA detected — ComfyUI will use CUDA.' }
else { Warn 'No NVIDIA GPU — ComfyUI will run in CPU mode (slow). Blender is the better free path for non-NVIDIA; tell OSHAL.' }

New-Item -ItemType Directory -Force -Path $Root | Out-Null
Set-Location $Root

# --- 2. Download + extract ComfyUI portable ---------------------------------
$comfyDir = Join-Path $Root 'ComfyUI_windows_portable'
if (-not (Test-Path $comfyDir)) {
  $archive = Join-Path $Root 'comfyui_portable.7z'
  if (-not (Test-Path $archive)) {
    Say 'Downloading ComfyUI portable (~1.5 GB, one time)…'
    Invoke-WebRequest -Uri $PortableUrl -OutFile $archive
  }
  $sevenzr = Join-Path $Root '7zr.exe'
  if (-not (Test-Path $sevenzr)) { Say 'Fetching 7-Zip extractor…'; Invoke-WebRequest -Uri $SevenZrUrl -OutFile $sevenzr }
  Say 'Extracting (a few minutes)…'
  & $sevenzr x $archive "-o$Root" -y | Out-Null
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
} else { Say 'ComfyUI already extracted — skipping download.' }
if (-not (Test-Path $comfyDir)) { throw "Extraction failed — $comfyDir not found." }

# --- 3. ComfyUI-Manager (needs git; the OSHAL repo clone provides it) --------
$customNodes = Join-Path $comfyDir 'ComfyUI\custom_nodes'
$mgr = Join-Path $customNodes 'ComfyUI-Manager'
if ((Get-Command git -ErrorAction SilentlyContinue) -and -not (Test-Path $mgr)) {
  Say 'Installing ComfyUI-Manager…'
  git clone --depth 1 https://github.com/ltdrdata/ComfyUI-Manager $mgr 2>$null
} elseif (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Warn 'git not found — skipping ComfyUI-Manager (install models via the ComfyUI UI instead).'
}

# --- 4. Start script (listen on the network) + auto-start shortcut -----------
$cpuFlag = if ($isNvidia) { '' } else { ' --cpu' }
$startBat = Join-Path $Root 'start-oshal-comfyui.bat'
@"
@echo off
cd /d "$comfyDir"
.\python_embeded\python.exe -s ComfyUI\main.py --listen 0.0.0.0 --port $Port$cpuFlag
"@ | Set-Content -Encoding ascii $startBat
Say "Wrote start script: $startBat"

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'OSHAL-ComfyUI.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk); $sc.TargetPath = $startBat; $sc.WorkingDirectory = $Root; $sc.WindowStyle = 7; $sc.Save()
Say 'Auto-start shortcut installed (runs at login).'

# --- 5. Tailscale -----------------------------------------------------------
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue) -and -not (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) {
  Say 'Installing Tailscale…'
  $ts = Join-Path $Root 'tailscale-setup.exe'
  Invoke-WebRequest -Uri $TailscaleUrl -OutFile $ts
  Start-Process -FilePath $ts -ArgumentList '/quiet' -Wait
}
$tscli = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tscli) { $tscli = "$env:ProgramFiles\Tailscale\tailscale.exe" }
try { & $tscli up } catch { Warn 'Run "tailscale up" once to sign in to your tailnet.' }
$tsip = (& $tscli ip -4 2>$null | Select-Object -First 1)

# --- 6. Launch + report -----------------------------------------------------
Say 'Starting ComfyUI…'
Start-Process -FilePath $startBat -WindowStyle Minimized
Start-Sleep -Seconds 5

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host ' OSHAL ComfyUI edge-node is set up.' -ForegroundColor Green
if ($tsip) { Write-Host " Send OSHAL this URL:  http://${tsip}:$Port" -ForegroundColor Green }
else { Write-Host " Sign in with 'tailscale up', then your URL is http://<tailscale-ip>:$Port" -ForegroundColor Yellow }
Write-Host " Local check:          http://localhost:$Port" -ForegroundColor Green
if (-not $isNvidia) { Write-Host ' NOTE: no NVIDIA GPU — generation will be slow; consider Blender instead.' -ForegroundColor Yellow }
Write-Host '============================================================' -ForegroundColor Green
