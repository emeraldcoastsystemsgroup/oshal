"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for offline transcription, led by the one that matters: a 54-minute recording was decoded to its FIRST MINUTE and returned as a successful transcript. ffmpeg is handed `-t <limit>`, so anything longer comes back truncated rather than rejected, and every downstream step then succeeds on the wrong audio. Nothing was red. A wrong answer delivered confidently is worse than an error, so landing on the decode wall is now refused outright.
"""

from __future__ import annotations

import numpy as np
import pytest

from speaker_service.audio import AudioInputError, FfmpegNormalizer, NormalizedAudio
from speaker_service.schemas import DiarizationResponse, DiarizedSpeaker, DiarizedTurn
from speaker_service.settings import ServiceSettings
from speaker_service.transcription import MIN_TURN_SECONDS, OfflineTranscriptionProcessor


def _settings(**overrides) -> ServiceSettings:
    base = dict(
        service_key="k" * 32,
        models_dir=overrides.pop("models_dir", "/models"),
        max_offline_duration_seconds=overrides.pop("max_offline_duration_seconds", 7200.0),
    )
    base.update(overrides)
    from pathlib import Path

    base["models_dir"] = Path(base["models_dir"])
    return ServiceSettings(**base)


class _StubNormalizer:
    """Stands in for ffmpeg; `decode_limit_seconds` is the wall under test."""

    def __init__(self, duration: float, limit: float) -> None:
        self._duration = duration
        self.decode_limit_seconds = limit

    def normalize(self, encoded: bytearray) -> NormalizedAudio:
        samples = np.zeros(int(self._duration * 16_000), dtype=np.float32)
        return NormalizedAudio(samples)


class _StubEngine:
    def __init__(self, turns) -> None:
        self._turns = turns

    def diarize(self, samples: np.ndarray) -> DiarizationResponse:
        return DiarizationResponse(
            modelId="stub",
            sampleRate=16_000,
            durationSeconds=float(samples.size) / 16_000,
            turns=self._turns,
            speakers=[DiarizedSpeaker(speakerKey="speaker-1", embedding=[0.0], voicedSeconds=1.0)],
        )


class _StubTranscriber:
    available = True

    def __init__(self) -> None:
        self.calls = 0

    def transcribe(self, samples: np.ndarray) -> str:
        self.calls += 1
        return f"words-{self.calls}"


def _turn(index: int, start: float, end: float, speaker: str = "speaker-1") -> DiarizedTurn:
    return DiarizedTurn(turnIndex=index, speakerKey=speaker, startTime=start, endTime=end, overlap=False)


def test_audio_landing_on_the_decode_wall_is_refused_not_truncated():
    """THE BUG. ffmpeg stops at the limit, so a longer file returns short and 'succeeds'."""
    processor = OfflineTranscriptionProcessor(
        _StubNormalizer(duration=59.0, limit=59.0),
        _StubEngine([_turn(0, 0.0, 50.0)]),
        _StubTranscriber(),
        max_duration=7200.0,
    )
    with pytest.raises(AudioInputError) as excinfo:
        processor.process(bytearray(b"x"))
    assert excinfo.value.status_code == 413
    assert excinfo.value.code == "audio_too_long"
    assert "truncat" in str(excinfo.value).lower()


def test_recording_well_inside_the_limit_is_transcribed():
    transcriber = _StubTranscriber()
    processor = OfflineTranscriptionProcessor(
        _StubNormalizer(duration=120.0, limit=7201.0),
        _StubEngine([_turn(0, 0.0, 5.0), _turn(1, 6.0, 11.0, "speaker-2")]),
        transcriber,
        max_duration=7200.0,
    )
    result = processor.process(bytearray(b"x"))
    assert [s.speakerKey for s in result.segments] == ["speaker-1", "speaker-2"]
    assert result.speakerCount == 2
    assert transcriber.calls == 2


def test_sub_threshold_turns_are_skipped_without_calling_the_model():
    """A breath clipped by the segmenter costs a model pass and invents filler."""
    transcriber = _StubTranscriber()
    processor = OfflineTranscriptionProcessor(
        _StubNormalizer(duration=60.0, limit=7201.0),
        _StubEngine([_turn(0, 0.0, MIN_TURN_SECONDS / 2), _turn(1, 2.0, 8.0)]),
        transcriber,
        max_duration=7200.0,
    )
    result = processor.process(bytearray(b"x"))
    assert transcriber.calls == 1
    assert len(result.segments) == 1


def test_missing_asr_model_is_a_503_not_a_crash():
    """Diarization-only images stay valid; transcription simply is not offered."""

    class _Absent(_StubTranscriber):
        available = False

    processor = OfflineTranscriptionProcessor(
        _StubNormalizer(duration=10.0, limit=7201.0),
        _StubEngine([_turn(0, 0.0, 5.0)]),
        _Absent(),
        max_duration=7200.0,
    )
    with pytest.raises(AudioInputError) as excinfo:
        processor.process(bytearray(b"x"))
    assert excinfo.value.status_code == 503


def test_ambient_normalizer_bounds_are_unchanged_by_the_offline_path():
    """The 58-second live cap is deliberate. Offline work must not widen it."""
    settings = _settings()
    ambient = FfmpegNormalizer(settings)
    assert ambient.decode_limit_seconds == settings.max_duration_seconds + 1.0 == 59.0
    offline = FfmpegNormalizer(
        settings,
        max_duration_seconds=settings.max_offline_duration_seconds,
        timeout_seconds=settings.offline_ffmpeg_timeout_seconds,
    )
    assert offline.decode_limit_seconds == 7201.0
