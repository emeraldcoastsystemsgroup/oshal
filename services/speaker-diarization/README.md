# OSHAL local speaker diarization

This isolated service answers one question: **which anonymous voice spoke
when?** It does not infer a person's name. OSHAL's owner-scoped profile layer
may later cluster the returned embeddings and let a user assign a name.

The service uses sherpa-onnx 1.13.1 with a checksum-pinned Pyannote 3.0
segmentation model and English VoxCeleb ERes2Net speaker embeddings. Inference
is CPU-only, single-threaded, and offline.

## Privacy boundary

- `POST /v1/diarize` accepts the encoded audio file as its raw HTTP body.
- Multipart uploads, HTTP content encodings, URLs, paths, and base64 JSON are
  not accepted.
- FFmpeg reads stdin and writes 16 kHz mono float32 PCM to stdout.
- No audio file, Redis job, database row, object, or model-provider request is
  created.
- Logs contain request IDs, byte counts, timings, and result counts only.
- Encoded and normalized buffers are overwritten on a best-effort basis.
- Decode and native inference are single-flight. A concurrent request receives
  `429 {"error":"service_busy"}` before its body is read; the service never
  queues audio in memory for later inference.
- Decoded audio is rejected beyond 58 seconds, independently of any client
  timestamps. Controller recording imports stop at 55 seconds.

Memory zeroization is not a hard guarantee in CPython, FFmpeg, or ONNX Runtime,
because those runtimes may make internal copies. The guarantee is that this
service has no durable-audio write path.

## Build and run

```bash
docker build -t oshal-speaker-diarization ./services/speaker-diarization
docker run --rm -p 18080:8080 \
  -e SPEAKER_SERVICE_KEY='replace-with-at-least-16-characters' \
  oshal-speaker-diarization
```

Both endpoints require `X-Speaker-Service-Key`.

```bash
curl -fsS http://127.0.0.1:18080/health \
  -H 'X-Speaker-Service-Key: replace-with-at-least-16-characters'

curl -fsS http://127.0.0.1:18080/v1/diarize \
  -H 'X-Speaker-Service-Key: replace-with-at-least-16-characters' \
  -H 'Content-Type: audio/webm' \
  --data-binary @conversation.webm
```

The response is:

```json
{
  "modelId": "sherpa-onnx-1.13.1/pyannote-segmentation-3.0/3dspeaker-eres2net-en-voxceleb-16k",
  "sampleRate": 16000,
  "durationSeconds": 12.4,
  "turns": [
    {"turnIndex": 0, "speakerKey": "speaker-1", "startTime": 0.2, "endTime": 2.1, "overlap": false}
  ],
  "speakers": [
    {"speakerKey": "speaker-1", "embedding": [0.01, -0.02], "voicedSeconds": 1.9}
  ]
}
```

`speakerKey` is local to one request. Stable anonymous profiles are intentionally
the caller's responsibility and must use `modelId` when comparing embeddings.
Audio with no detected speaker turn returns `422` with
`{"error":"no_speech_detected"}`. The controller treats that expected quiet
interval as a no-op rather than an outage.

## Tests

Install test dependencies outside the application environment, then run:

```bash
python -m pip install -r services/speaker-diarization/requirements-dev.txt
python -m pytest -q services/speaker-diarization/tests
```

For a real-model smoke, build/run the container and post actual speech:

```bash
python services/speaker-diarization/scripts/smoke.py \
  --url http://127.0.0.1:18080 \
  --key replace-with-at-least-16-characters \
  --audio conversation.wav
```

The smoke fails if the service returns no turns, no speakers, or an empty
embedding. A real human-speech fixture is intentionally not committed.

Model origins, hashes, and licenses are recorded in
[model-manifest.json](model-manifest.json) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
