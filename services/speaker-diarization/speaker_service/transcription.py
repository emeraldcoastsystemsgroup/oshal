"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Offline speaker-labelled transcription: diarize a whole recording in ONE pass, then run local ASR per speaker turn. Added so a customer call can be transcribed without the audio leaving the box — the existing STT providers are all cloud, and a client's recorded call is exactly the material you do not hand to a third party while selling them self-hosting. Moonshine (not Whisper) because sherpa-onnx pads every Whisper segment to 30s: transcribing hundreds of short turns that way costs a full 30-second forward pass for a two-second turn. The ASR model loads LAZILY so the ambient diarization path keeps its resting footprint.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from .audio import AudioInputError, FfmpegNormalizer, NormalizedAudio
from .engine import DeterministicDiarizationEngine, SherpaBackend
from .schemas import TranscriptSegment, TranscriptionResponse
from .settings import ASR_MODEL_ID, MODEL_ID, SAMPLE_RATE, ServiceSettings

# A turn shorter than this carries no recoverable words — usually a breath or a
# backchannel clipped by the segmenter. Transcribing it wastes a model pass and
# tends to hallucinate a filler token.
MIN_TURN_SECONDS = 0.35
# Guard against a pathological single turn: cap what one ASR call sees.
MAX_TURN_SECONDS = 120.0


@dataclass(frozen=True)
class _Turn:
    speaker: str
    start: float
    end: float


class LocalTranscriber:
    """Lazily-built Moonshine recognizer. Owns its own construction lock."""

    def __init__(self, settings: ServiceSettings) -> None:
        self._settings = settings
        self._recognizer = None
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        """True when the pinned ASR model files are present in the image."""
        return self._settings.asr_available

    def _ensure(self):
        if self._recognizer is not None:
            return self._recognizer
        with self._lock:
            if self._recognizer is None:
                import sherpa_onnx

                s = self._settings
                self._recognizer = sherpa_onnx.OfflineRecognizer.from_moonshine(
                    preprocessor=str(s.asr_preprocessor),
                    encoder=str(s.asr_encoder),
                    uncached_decoder=str(s.asr_uncached_decoder),
                    cached_decoder=str(s.asr_cached_decoder),
                    tokens=str(s.asr_tokens),
                    num_threads=s.asr_threads,
                    provider="cpu",
                    debug=False,
                )
        return self._recognizer

    def transcribe(self, samples: np.ndarray) -> str:
        """Decode one contiguous float32 waveform to text."""
        if samples.size == 0:
            return ""
        recognizer = self._ensure()
        stream = recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        recognizer.decode_stream(stream)
        return (stream.result.text or "").strip()


class OfflineTranscriptionProcessor:
    """Diarize a whole recording once, then transcribe each speaker turn.

    Diarizing the FULL file in a single pass is what keeps speaker labels
    consistent end to end — chunking the audio first would cluster each chunk
    independently and 'speaker-1' in minute 3 need not be 'speaker-1' in
    minute 40.
    """

    def __init__(
        self,
        normalizer: FfmpegNormalizer,
        engine: DeterministicDiarizationEngine,
        transcriber: LocalTranscriber,
        max_duration: float,
    ) -> None:
        self._normalizer = normalizer
        self._engine = engine
        self._transcriber = transcriber
        self._max_duration = max_duration
        self._lock = threading.Lock()

    def process(self, encoded: bytearray) -> TranscriptionResponse:
        """Normalize, diarize, transcribe per turn, and wipe the decoded PCM."""
        if not self._transcriber.available:
            raise AudioInputError(503, "asr_unavailable", "No local ASR model is installed in this image")
        audio: NormalizedAudio | None = None
        with self._lock:
            try:
                audio = self._normalizer.normalize(encoded)
                # ffmpeg is told to stop at the decode limit, so a longer recording comes back
                # SILENTLY TRUNCATED and every downstream step succeeds on the wrong audio —
                # a 54-minute call once produced a confident one-minute transcript. Landing on
                # the wall is indistinguishable from being cut off at it, so refuse both.
                if audio.duration_seconds >= self._normalizer.decode_limit_seconds - 0.5:
                    raise AudioInputError(
                        413,
                        "audio_too_long",
                        "Recording reaches the decode limit and would be truncated; raise "
                        "SPEAKER_MAX_OFFLINE_DURATION_SECONDS or split the file",
                    )
                if audio.duration_seconds > self._max_duration:
                    raise AudioInputError(413, "audio_too_long", "Decoded audio exceeds the offline duration limit")
                diarization = self._engine.diarize(audio.samples)
                segments = self._transcribe_turns(audio.samples, diarization.turns)
                return TranscriptionResponse(
                    modelId=MODEL_ID,
                    asrModelId=ASR_MODEL_ID,
                    sampleRate=SAMPLE_RATE,
                    durationSeconds=audio.duration_seconds,
                    speakerCount=len({s.speakerKey for s in segments}) if segments else 0,
                    segments=segments,
                )
            finally:
                if audio is not None:
                    audio.wipe()

    def _transcribe_turns(self, samples: np.ndarray, turns: Sequence) -> list[TranscriptSegment]:
        out: list[TranscriptSegment] = []
        total = samples.shape[0]
        for index, turn in enumerate(turns):
            start, end = float(turn.startTime), float(turn.endTime)
            if end - start < MIN_TURN_SECONDS:
                continue
            end = min(end, start + MAX_TURN_SECONDS)
            lo = max(0, int(start * SAMPLE_RATE))
            hi = min(total, int(end * SAMPLE_RATE))
            if hi <= lo:
                continue
            text = self._transcriber.transcribe(np.ascontiguousarray(samples[lo:hi]))
            if not text:
                continue
            out.append(
                TranscriptSegment(
                    index=len(out),
                    speakerKey=turn.speakerKey,
                    startTime=round(start, 3),
                    endTime=round(end, 3),
                    text=text,
                )
            )
        return out


def create_transcription_processor(settings: ServiceSettings) -> OfflineTranscriptionProcessor:
    """Build the offline transcription processor from the pinned local models."""
    backend = SherpaBackend(settings)
    engine = DeterministicDiarizationEngine(backend)
    return OfflineTranscriptionProcessor(
        FfmpegNormalizer(
            settings,
            max_duration_seconds=settings.max_offline_duration_seconds,
            timeout_seconds=settings.offline_ffmpeg_timeout_seconds,
        ),
        engine,
        LocalTranscriber(settings),
        settings.max_offline_duration_seconds,
    )
