param(
  [Parameter(Mandatory = $false)]
  [ValidatePattern("^[\p{L}\p{N} '-]{1,32}$")]
  [string]$AssistantName = 'Jarvis',

  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[A-Za-z]{2}-[A-Za-z]{2}$')]
  [string]$Locale = 'en-US'
)

$ErrorActionPreference = 'Stop'
$engine = $null
$synth = $null
$audio = $null

try {
  Add-Type -AssemblyName System.Speech
  $phrase = "Hey $AssistantName"
  $culture = [System.Globalization.CultureInfo]::GetCultureInfo($Locale)
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($culture)
  $choices = [System.Speech.Recognition.Choices]::new([string[]]@($phrase))
  $builder = [System.Speech.Recognition.GrammarBuilder]::new()
  $builder.Culture = $culture
  $builder.Append($choices)
  $engine.LoadGrammar([System.Speech.Recognition.Grammar]::new($builder))

  # A deterministic, privacy-safe smoke: synthesize into RAM, then recognize from
  # that same MemoryStream. No microphone is opened and no WAV file is created.
  $audio = [System.IO.MemoryStream]::new()
  $synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  $synth.SetOutputToWaveStream($audio)
  $synth.Speak($phrase)
  $synth.SetOutputToNull()
  $audio.Position = 0
  $engine.SetInputToWaveStream($audio)
  $result = $engine.Recognize([TimeSpan]::FromSeconds(8))

  if ($null -eq $result -or $result.Text -ne $phrase) {
    throw "Offline recognizer did not return the exact wake phrase."
  }

  [Console]::Out.WriteLine((@{
    ok = $true
    phrase = $phrase
    locale = $Locale
    confidence = $result.Confidence
    rawAudioStored = $false
  } | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.WriteLine((@{
    ok = $false
    error = $_.Exception.Message
  } | ConvertTo-Json -Compress))
  exit 1
} finally {
  if ($null -ne $engine) { $engine.Dispose() }
  if ($null -ne $synth) { $synth.Dispose() }
  if ($null -ne $audio) { $audio.Dispose() }
}
