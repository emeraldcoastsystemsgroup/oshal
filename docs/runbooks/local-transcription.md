# Local transcription — speaker-labelled, nothing leaves the host

Transcribe a recording (a customer call, a meeting, a voice note) into a **speaker-labelled**
transcript using only this machine. No cloud STT, no API key, no audio upload.

## When to use this instead of a cloud provider

The other STT providers here — `google-cloud-stt`, `gemini-stt`, `browser` — all send the audio
to someone else. That is fine for a voice command and wrong for material you are commercially or
contractually not free to hand over. A recorded customer call is the obvious case: shipping it to
a third party while pitching that customer on self-hosting is a contradiction they are entitled
to notice.

`local-stt` is the on-host option, and it is the only one that returns **who said what** rather
than one undifferentiated block of text.

## What runs it

The `speaker-diarization` sidecar (ADR-084), already on the compose network:

| stage | model | licence |
|---|---|---|
| who is speaking, when | `pyannote-segmentation-3.0` | MIT |
| who they are (embeddings) | `3dspeaker eres2net voxceleb 16k` | Apache-2.0 |
| the words | `moonshine-base-en-int8` | MIT |

All three are pinned by **sha256** in `services/speaker-diarization/Dockerfile` and listed in
`model-manifest.json`; a contract test fails if that set changes without being declared.

**Why Moonshine and not Whisper.** sherpa-onnx pads every Whisper segment to a fixed 30 seconds.
Transcribing a diarized call means hundreds of short turns, so Whisper would spend a full
30-second forward pass on a two-second "yeah, exactly". Moonshine takes variable-length input.
Measured on this host: **~1.5× realtime**, so a 54-minute call takes about 35 minutes on 4 threads.

The ASR model loads **lazily**, on first transcription. A deployment that only ever does ambient
diarization pays nothing for it, and an image built without the model still diarizes — the
endpoint simply answers `503`.

## Through the platform

```ts
// stt-provider-registry resolves 'local-stt' like any other provider
const provider = registry.get('local-stt');
const { text, segments } = await provider.transcribe({ audio, mimeType: 'audio/wav' });
// segments: [{ text: 'speaker-1: …', startTime, endTime }, …]
```

Needs `SPEAKER_DIARIZATION_URL` and `SPEAKER_SERVICE_KEY` (both already set in
`docker-compose.oshal-local.yml`). Unconfigured, it throws with the missing variable named — it
does **not** fall back to a cloud provider.

## One-off, for a file on disk

```bash
# 1. Normalise to what the models want. Any ffmpeg-readable input works.
docker run --rm -v "<dir>:/in:ro" -v "<out>:/out" --entrypoint ffmpeg oshal-speaker-diarization:asr \
  -v error -i "/in/call.m4a" -ac 1 -ar 16000 -c:a pcm_s16le /out/call.wav -y

# 2. Transcribe. 4 threads; raise --memory if you raise the thread count.
docker run --rm --memory=2500m -v "<out>:/work" -e SPEAKER_ASR_THREADS=4 \
  --entrypoint python oshal-speaker-diarization:asr \
  /app/scripts/run_transcribe.py /work/call.wav /work/call.json /work/call.md
```

Diarization runs over the **whole file in one pass** — that is what keeps `speaker-1` the same
person in minute 3 and minute 40. Chunking the audio first would cluster each chunk independently
and the labels would not line up.

## Limits, and the failure that matters

| bound | env | default |
|---|---|---|
| offline recording length | `SPEAKER_MAX_OFFLINE_DURATION_SECONDS` | 7200 (2 h) |
| offline upload size | `SPEAKER_MAX_OFFLINE_BYTES` | 512 MB |
| ASR threads | `SPEAKER_ASR_THREADS` | 4 |
| **live ambient chunk** | `SPEAKER_MAX_DURATION_SECONDS` | **58 — deliberate, do not widen it** |

The offline budget is deliberately separate from the ambient one. Raising a two-hour ceiling for
file transcription must not loosen the 58-second bound the live path depends on.

> ⚠ **The failure this was built around.** ffmpeg is invoked with `-t <limit>`, so a recording
> longer than the limit is not rejected — it is **silently truncated**, and every step after it
> succeeds on the wrong audio. A 54-minute call produced a confident, well-formed, entirely real
> one-minute transcript, and nothing anywhere went red. Landing on the decode wall is now refused
> with a `413` naming the variable to raise, because a wrong answer delivered confidently is worse
> than an error. Guarded by `tests/test_transcription.py`.

## Handling the output

A transcript of a customer call is the same confidential material as the recording.

- Keep both **out of git.** `oshal-app-private/.gitignore` covers audio and video; a `.md`
  transcript is not covered by default — put it somewhere deliberate.
- Recording a call is **two-party consent** in some states, Florida among them. Whether the
  transcript can be quoted in a proposal is a legal question, not a technical one.
- The sidecar holds audio in memory only and wipes the decoded PCM in a `finally` — nothing is
  written to disk by the service itself.
