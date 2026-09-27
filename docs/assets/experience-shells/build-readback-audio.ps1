<#
  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ                 | AUTHOR                      | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 design-study artifact (docs/assets/experience-shells), packaged from the 2026-09-25 home-design prototypes: regenerates nexus-readback-audio.js locally with the Windows speech synthesizer; no network or account access.
#>
# Regenerate the bundled demonstration voice locally; no network or account access.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$readbackTranscript = "All right. Let's make some room for a little adventure. In this demo, your calendar and travel tools come together in one place. I can help you compare the options, while you stay in control. Ready when you are."
$readbackVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$readbackStream = New-Object System.IO.MemoryStream
try {
    $readbackVoice.SelectVoice('Microsoft David Desktop')
    $readbackVoice.Rate = 0
    $readbackVoice.Volume = 85
    $readbackVoice.SetOutputToWaveStream($readbackStream)
    $readbackVoice.Speak($readbackTranscript)
    $readbackVoice.SetOutputToNull()
    $readbackAsset = [ordered]@{
        transcript = $readbackTranscript
        voice = 'Microsoft David Desktop / local placeholder voice'
        mime = 'audio/wav'
        base64 = [Convert]::ToBase64String($readbackStream.ToArray())
    } | ConvertTo-Json -Compress
    $readbackTarget = Join-Path $PSScriptRoot 'nexus-readback-audio.js'
    [System.IO.File]::WriteAllText($readbackTarget, ('/* Generated local sample audio. Regenerate with build-readback-audio.ps1. */' + [Environment]::NewLine + 'window.NexusReadbackAudio = Object.freeze(' + $readbackAsset + ');' + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
    Write-Output ('Generated local sample: ' + $readbackTarget)
} finally {
    $readbackVoice.Dispose()
    $readbackStream.Dispose()
}
