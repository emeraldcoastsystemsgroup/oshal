# OSHAL LoRA Studio - kohya_ss trainer setup (GPU box, run ONCE before train-lora.py).
# Installs the kohya/sd-scripts LoRA trainer into ~/kohya_ss with its own venv + CUDA torch, so the
# box can train a character LoRA on its GPU (free). This installs FREE software only - no OSHAL
# secrets, no remote-control agent. Re-running is safe (skips work already done).
#
#   powershell -ExecutionPolicy Bypass -File scripts\comfyui-edge\setup-kohya.ps1
#
# 8GB note (RTX 4060): SD1.5 LoRA training fits comfortably with fp16 + xformers + 8-bit Adam, which
# train-lora.py sets. Bigger bases (SDXL) would NOT fit - stay on the SD1.5 base the dataset was built on.
param([string]$Root = (Join-Path $HOME 'kohya_ss'))

function Say($m) { Write-Host "[setup-kohya] $m" -ForegroundColor Cyan }

# --- 1. Python + git present? ---------------------------------------------------------------
$py = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $py) { Write-Error "Python 3.10/3.11 is required on PATH. Install it, then re-run."; exit 1 }
$git = (Get-Command git -ErrorAction SilentlyContinue)
if (-not $git) { Write-Error "git is required on PATH. Install Git for Windows, then re-run."; exit 1 }

# --- 2. Clone kohya_ss (bundles sd-scripts: the train_network.py LoRA trainer) ---------------
if (-not (Test-Path (Join-Path $Root '.git'))) {
  Say "cloning kohya_ss -> $Root"
  git clone --recursive https://github.com/bmaltais/kohya_ss.git $Root
} else {
  Say "kohya_ss already present; pulling latest"
  Push-Location $Root; git pull --recurse-submodules; git submodule update --init --recursive; Pop-Location
}
$sd = Join-Path $Root 'sd-scripts'
if (-not (Test-Path (Join-Path $sd 'train_network.py'))) {
  Say "fetching sd-scripts submodule"
  Push-Location $Root; git submodule update --init --recursive; Pop-Location
}

# --- 3. venv + CUDA torch + trainer deps -----------------------------------------------------
# Resolve a REAL base interpreter. On this box bare `python` is the Windows Store alias stub (no
# venv module), so prefer an installed Python 3.10/3.11, else a non-WindowsApps python on PATH.
$basePy = $null
foreach ($cand in @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'))) {
  if (Test-Path $cand) { $basePy = $cand; break }
}
if (-not $basePy) {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -notlike '*WindowsApps*') { $basePy = $cmd.Source }
}
if (-not $basePy) { Write-Error 'No real Python found (only the Store stub). Install Python 3.10 first.'; exit 1 }
Say "base python: $basePy"
$venv = Join-Path $Root 'venv'
$vpy = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $vpy)) { Say "creating venv"; & $basePy -m venv $venv }
if (-not (Test-Path $vpy)) { Write-Error "venv creation failed ($vpy missing)"; exit 1 }
# PINNED, MATCHED versions — kohya SD1.5 is well-tested on torch 2.1.2+cu121 / xformers 0.0.23.post1.
# Unpinned installs let xformers/requirements clobber CUDA torch with a CPU build (cuda=False), so we
# pin, install the trainer deps + sd-scripts requirements in between, then RE-ASSERT the CUDA torch +
# matching xformers LAST (--force-reinstall) so nothing leaves a CPU build behind.
$CU = 'https://download.pytorch.org/whl/cu121'
Say "upgrading pip"
& $vpy -m pip install --upgrade pip wheel | Out-Null
Say "installing CUDA 12.1 torch 2.1.2 (this is large - a few minutes)"
& $vpy -m pip install torch==2.1.2 torchvision==0.16.2 --index-url $CU
# sd-scripts requirements — run from INSIDE sd-scripts so its trailing '.' (install the lib) resolves
# to sd-scripts and not the worker's CWD. Non-fatal if the editable line errors.
$req = Join-Path $sd 'requirements.txt'
if (Test-Path $req) {
  Say "installing sd-scripts requirements.txt"
  Push-Location $sd; & $vpy -m pip install -r requirements.txt; Pop-Location
}
# Use the EXACT versions kohya sd-scripts pins (its requirements.txt: accelerate 0.33.0 / transformers
# 4.44.0 / diffusers 0.25.0 / huggingface-hub 0.24.5). Older transformers lacks SchedulerType.
# COSINE_WITH_MIN_LR, which sd-scripts references unconditionally -> AttributeError at train start.
Say "installing trainer extras (kohya-pinned versions)"
& $vpy -m pip install accelerate==0.33.0 transformers==4.44.0 "diffusers[torch]==0.25.0" huggingface-hub==0.24.5 `
    safetensors bitsandbytes "open_clip_torch" ftfy opencv-python einops toml voluptuous
# RE-ASSERT the CUDA torch trio LAST so any clobber by the above is undone.
Say "re-asserting CUDA torch + matched xformers (final)"
& $vpy -m pip install --force-reinstall --no-deps torch==2.1.2 torchvision==0.16.2 --index-url $CU
& $vpy -m pip install --no-deps xformers==0.0.23.post1 --index-url $CU
# Verify CUDA is actually available before declaring success.
$cudaOk = (& $vpy -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 3)") 2>&1; $rc = $LASTEXITCODE
if ($rc -ne 0) { Write-Error "CUDA torch verification FAILED (torch.cuda.is_available()=False). Output: $cudaOk"; exit 1 }
Say "CUDA torch verified OK"

# --- 4. accelerate default config (single GPU, fp16, no distributed) --------------------------
$accelDir = Join-Path $env:USERPROFILE '.cache\huggingface\accelerate'
New-Item -ItemType Directory -Force -Path $accelDir | Out-Null
$accelCfg = Join-Path $accelDir 'default_config.yaml'
if (-not (Test-Path $accelCfg)) {
  Say "writing single-GPU fp16 accelerate config"
@"
compute_environment: LOCAL_MACHINE
distributed_type: 'NO'
mixed_precision: fp16
num_processes: 1
use_cpu: false
"@ | Set-Content -Encoding ascii $accelCfg
}

Say "DONE. kohya trainer ready at $Root (venv: $vpy)."
Say "Next: train-lora.py will call this venv's python on sd-scripts\train_network.py."
