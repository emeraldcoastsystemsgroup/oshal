# Node-side daily trade-recap render. Runs ON the render node (has repo + PowerPoint +
# python + brand assets + Alpaca .env). Started DETACHED by the in-container dispatcher
# (oshal-recap-render-remote.js) so it isn't bound by the node's 120s shell.exec limit.
# Writes a sentinel: recap-build.done (JSON payload) on success, recap-build.err on failure.
$ErrorActionPreference = 'Stop'
$root = 'C:\Projects\open-shal-swarm-harness-agent-llm'
$out  = Join-Path $root 'packages\oshal-vids-operator\out'
$done = Join-Path $out 'recap-build.done'
$err  = Join-Path $out 'recap-build.err'
$log  = Join-Path $out 'recap-build.log'
Remove-Item $done, $err -ErrorAction SilentlyContinue
try {
  # 1) Build data + deck + video via the proven, deterministic pipeline.
  $p = Start-Process -FilePath (Join-Path $root 'scripts\make-trade-report.cmd') `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError (Join-Path $out 'recap-build.err.log')
  if ($p.ExitCode -ne 0) { throw "make-trade-report.cmd exit $($p.ExitCode)" }

  # 2) Newest report MP4.
  $rep = Get-ChildItem (Join-Path $out 'oshal-report-*.mp4') | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $rep) { throw 'no report mp4 produced' }

  # 3) Gmail-sized copy for the notification attachment (best-effort).
  #    ffmpeg writes its banner/progress to stderr; under EAP=Stop with 2>&1 PowerShell turns
  #    that into a terminating NativeCommandError, so redirect stderr to a log and don't stop.
  $ff = (& python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())").Trim()
  $small = Join-Path $out 'recap-email.mp4'
  Remove-Item $small -ErrorAction SilentlyContinue
  $ErrorActionPreference = 'Continue'
  & $ff -y -i $rep.FullName -vcodec libx264 -crf 30 -preset veryfast -vf "scale=1280:-2" -acodec aac -b:a 96k $small 2> (Join-Path $out 'recap-compress.log')
  $cexit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($cexit -ne 0 -or -not (Test-Path $small)) { $small = $null }

  # 4) Result payload (numbers from recap-data.json + paths).
  $data = $null
  $djson = Join-Path $out 'recap-data.json'
  if (Test-Path $djson) { $data = Get-Content $djson -Raw | ConvertFrom-Json }
  $compressedMB = if ($small -and (Test-Path $small)) { [math]::Round((Get-Item $small).Length/1MB, 2) } else { $null }
  $payload = [ordered]@{
    ok           = $true
    report       = $rep.FullName
    reportName   = $rep.Name
    reportMB     = [math]::Round($rep.Length/1MB, 2)
    compressed   = $small
    compressedMB = $compressedMB
    data         = $data
  }
  ($payload | ConvertTo-Json -Depth 8 -Compress) | Out-File $done -Encoding utf8
} catch {
  ($_.Exception.Message) | Out-File $err -Encoding utf8
}
