"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Added deterministic ordering, overlap, embedding, and cleanup tests.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np
import pytest

from speaker_service.audio import AudioInputError, NormalizedAudio, _ffmpeg_command
from speaker_service.engine import (
    DeterministicDiarizationEngine,
    LocalDiarizationProcessor,
    RawTurn,
)
from speaker_service.settings import MODEL_ID, SAMPLE_RATE


class RecordingBackend:
    """Predictable backend whose embeddings expose the selected sample count."""

    def __init__(self, turns: Sequence[RawTurn]) -> None:
        self.turns = list(turns)
        self.embedding_sample_counts: list[int] = []

    def diarize(self, _samples: np.ndarray) -> Sequence[RawTurn]:
        return self.turns

    def embed(self, samples: np.ndarray) -> Sequence[float]:
        self.embedding_sample_counts.append(int(samples.size))
        return [3.0, 4.0]


def test_assigns_speaker_keys_by_first_appearance_and_marks_overlap() -> None:
    backend = RecordingBackend([
        RawTurn(8, 2.0, 4.0),
        RawTurn(3, 0.25, 2.5),
        RawTurn(3, -1.0, 0.1),
        RawTurn(9, 8.0, 8.0),
    ])
    samples = np.zeros(SAMPLE_RATE * 5, dtype=np.float32)

    result = DeterministicDiarizationEngine(backend).diarize(samples)

    assert result.modelId == MODEL_ID
    assert [turn.speakerKey for turn in result.turns] == ["speaker-1", "speaker-1", "speaker-2"]
    assert [turn.turnIndex for turn in result.turns] == [0, 1, 2]
    assert [turn.overlap for turn in result.turns] == [False, True, True]
    assert result.turns[0].startTime == 0.0
    assert [speaker.speakerKey for speaker in result.speakers] == ["speaker-1", "speaker-2"]


def test_excludes_overlapping_audio_from_embeddings_and_normalizes_vectors() -> None:
    backend = RecordingBackend([
        RawTurn(0, 0.0, 2.0),
        RawTurn(1, 1.5, 3.0),
    ])
    samples = np.ones(SAMPLE_RATE * 3, dtype=np.float32)

    result = DeterministicDiarizationEngine(backend).diarize(samples)

    assert backend.embedding_sample_counts == [int(1.5 * SAMPLE_RATE), int(1.0 * SAMPLE_RATE)]
    assert result.speakers[0].embedding == [0.6, 0.8]
    assert result.speakers[0].voicedSeconds == 2.0
    assert result.speakers[1].voicedSeconds == 1.5
    assert math.isclose(sum(value * value for value in result.speakers[0].embedding), 1.0)


def test_falls_back_to_all_voiced_audio_when_exclusive_audio_is_short() -> None:
    backend = RecordingBackend([
        RawTurn(0, 0.0, 1.0),
        RawTurn(1, 0.2, 0.9),
    ])
    samples = np.ones(SAMPLE_RATE, dtype=np.float32)

    DeterministicDiarizationEngine(backend).diarize(samples)

    assert backend.embedding_sample_counts == [SAMPLE_RATE, SAMPLE_RATE]


def test_rejects_audio_without_speaker_turns() -> None:
    engine = DeterministicDiarizationEngine(RecordingBackend([]))

    with pytest.raises(AudioInputError, match="No speaker turns"):
        engine.diarize(np.zeros(SAMPLE_RATE, dtype=np.float32))


class RecordingNormalizer:
    """Normalizer that retains the mutable sample array for wipe assertions."""

    def __init__(self, duration: float = 1.0) -> None:
        self.audio = NormalizedAudio(np.ones(int(duration * SAMPLE_RATE), dtype=np.float32))

    def normalize(self, _encoded: bytearray) -> NormalizedAudio:
        return self.audio


def test_processor_wipes_pcm_after_success() -> None:
    normalizer = RecordingNormalizer()
    backend = RecordingBackend([RawTurn(0, 0.0, 1.0)])
    processor = LocalDiarizationProcessor(
        normalizer, DeterministicDiarizationEngine(backend), max_duration=5.0,
    )

    result = processor.process(bytearray(b"encoded"))

    assert result.turns
    assert np.count_nonzero(normalizer.audio.samples) == 0


def test_processor_wipes_pcm_when_duration_is_rejected() -> None:
    normalizer = RecordingNormalizer(duration=2.0)
    processor = LocalDiarizationProcessor(
        normalizer, DeterministicDiarizationEngine(RecordingBackend([])), max_duration=1.0,
    )

    with pytest.raises(AudioInputError, match="duration limit"):
        processor.process(bytearray(b"encoded"))

    assert np.count_nonzero(normalizer.audio.samples) == 0


def test_ffmpeg_decode_is_bounded_one_second_beyond_duration_limit() -> None:
    command = _ffmpeg_command("ffmpeg", 180.0)

    assert command[command.index("-t") + 1] == "181.000000"
    assert command[-3:] == ["-f", "f32le", "pipe:1"]
