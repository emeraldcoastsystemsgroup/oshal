"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | One-off runner for transcribing a file on disk without standing the service up. Ships with the sidecar so the command in docs/runbooks/local-transcription.md is runnable as written rather than being a snippet someone has to reconstruct.
"""

"""One-off runner: drive the sidecar's offline transcription on a local file.

Runs INSIDE the speaker-diarization image, so the audio never leaves this host.
Usage: python run_transcribe.py <audio-in> <json-out> [<markdown-out>]
"""
import json
import os
import sys
import time

sys.path.insert(0, "/app")

from speaker_service.settings import ServiceSettings          # noqa: E402
from speaker_service.transcription import create_transcription_processor  # noqa: E402

audio_path, json_out = sys.argv[1], sys.argv[2]
md_out = sys.argv[3] if len(sys.argv) > 3 else None

os.environ.setdefault("SPEAKER_SERVICE_KEY", "local-offline-transcription-key")
settings = ServiceSettings.from_environment()
print(f"asr available: {settings.asr_available}  threads: {settings.asr_threads}", flush=True)

processor = create_transcription_processor(settings)
with open(audio_path, "rb") as fh:
    encoded = bytearray(fh.read())
print(f"audio bytes: {len(encoded):,}", flush=True)

started = time.monotonic()
result = processor.process(encoded)
elapsed = time.monotonic() - started

payload = result.model_dump()
with open(json_out, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2, ensure_ascii=False)

if md_out:
    lines = [
        "# Transcript",
        "",
        f"- Duration: {payload['durationSeconds'] / 60:.1f} min",
        f"- Speakers detected: {payload['speakerCount']}",
        f"- Diarization: `{payload['modelId']}`",
        f"- ASR: `{payload['asrModelId']}`",
        "- Produced entirely on this host. No audio left the machine.",
        "",
        "---",
        "",
    ]
    last = None
    for seg in payload["segments"]:
        stamp = time.strftime("%H:%M:%S", time.gmtime(seg["startTime"]))
        if seg["speakerKey"] != last:
            lines.append("")
            lines.append(f"**{seg['speakerKey']}**  `{stamp}`")
            last = seg["speakerKey"]
        lines.append(seg["text"])
    with open(md_out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

print(
    f"done in {elapsed / 60:.1f} min | {payload['durationSeconds'] / 60:.1f} min audio "
    f"| {len(payload['segments'])} segments | {payload['speakerCount']} speakers "
    f"| {payload['durationSeconds'] / max(elapsed, 1e-9):.2f}x realtime",
    flush=True,
)
