"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Added deterministic sherpa-onnx diarization, overlap detection, and speaker embeddings.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Protocol, Sequence

import numpy as np

from .audio import AudioInputError, FfmpegNormalizer, NormalizedAudio
from .schemas import DiarizationResponse, DiarizedSpeaker, DiarizedTurn
from .settings import (
    CLUSTER_THRESHOLD,
    CPU_THREADS,
    MIN_DURATION_OFF,
    MIN_DURATION_ON,
    MODEL_ID,
    SAMPLE_RATE,
    ServiceSettings,
)

TIME_PRECISION = 6
EMBEDDING_PRECISION = 8
MIN_EXCLUSIVE_EMBEDDING_SECONDS = 0.5
MIN_EMBEDDING_SECONDS = 1.0


@dataclass(frozen=True)
class RawTurn:
    """Backend-neutral turn before deterministic speaker-key assignment."""

    speaker: int
    start: float
    end: float


class SpeakerBackend(Protocol):
    """Minimal model boundary used by deterministic engine tests."""

    def diarize(self, samples: np.ndarray) -> Sequence[RawTurn]: ...

    def embed(self, samples: np.ndarray) -> Sequence[float]: ...


class SherpaBackend:
    """Pinned sherpa-onnx CPU backend with one inference thread."""

    def __init__(self, settings: ServiceSettings) -> None:
        import sherpa_onnx

        self._sherpa = sherpa_onnx
        self._diarizer = self._create_diarizer(settings)
        self._extractor = self._create_extractor(settings)

    def _create_diarizer(self, settings: ServiceSettings):
        so = self._sherpa
        segmentation = so.OfflineSpeakerSegmentationModelConfig(
            pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(settings.segmentation_model),
            ),
            num_threads=CPU_THREADS,
            debug=False,
            provider="cpu",
        )
        embedding = _embedding_config(so, settings)
        config = so.OfflineSpeakerDiarizationConfig(
            segmentation=segmentation,
            embedding=embedding,
            clustering=so.FastClusteringConfig(num_clusters=-1, threshold=CLUSTER_THRESHOLD),
            min_duration_on=MIN_DURATION_ON,
            min_duration_off=MIN_DURATION_OFF,
        )
        if not config.validate():
            raise RuntimeError("Pinned sherpa-onnx diarization configuration is invalid")
        return so.OfflineSpeakerDiarization(config)

    def _create_extractor(self, settings: ServiceSettings):
        config = _embedding_config(self._sherpa, settings)
        if not config.validate():
            raise RuntimeError("Pinned speaker-embedding configuration is invalid")
        return self._sherpa.SpeakerEmbeddingExtractor(config)

    def diarize(self, samples: np.ndarray) -> Sequence[RawTurn]:
        """Run offline diarization and normalize native results."""
        result = self._diarizer.process(samples).sort_by_start_time()
        return [RawTurn(int(turn.speaker), float(turn.start), float(turn.end)) for turn in result]

    def embed(self, samples: np.ndarray) -> Sequence[float]:
        """Extract one voice vector from a contiguous float32 waveform."""
        if samples.size == 0:
            return []
        stream = self._extractor.create_stream()
        stream.accept_waveform(sample_rate=SAMPLE_RATE, waveform=samples)
        stream.input_finished()
        if not self._extractor.is_ready(stream):
            return []
        return self._extractor.compute(stream)


def _embedding_config(sherpa_module, settings: ServiceSettings):
    return sherpa_module.SpeakerEmbeddingExtractorConfig(
        model=str(settings.embedding_model),
        num_threads=CPU_THREADS,
        debug=False,
        provider="cpu",
    )


class DeterministicDiarizationEngine:
    """Convert model turns into a stable, ordered, model-versioned response."""

    def __init__(self, backend: SpeakerBackend) -> None:
        self._backend = backend

    def diarize(self, samples: np.ndarray) -> DiarizationResponse:
        """Diarize one normalized chunk and compute per-speaker embeddings."""
        duration = float(samples.size) / SAMPLE_RATE
        raw_turns = _sanitize_turns(self._backend.diarize(samples), duration)
        if not raw_turns:
            raise AudioInputError(422, "no_speech_detected", "No speaker turns were detected")
        keyed_turns, speaker_order = _key_turns(raw_turns)
        response_turns = _response_turns(keyed_turns)
        speakers = self._build_speakers(samples, keyed_turns, speaker_order)
        return DiarizationResponse(
            modelId=MODEL_ID,
            sampleRate=SAMPLE_RATE,
            durationSeconds=round(duration, TIME_PRECISION),
            turns=response_turns,
            speakers=speakers,
        )

    def _build_speakers(
        self,
        samples: np.ndarray,
        turns: list[tuple[str, float, float]],
        speaker_order: list[str],
    ) -> list[DiarizedSpeaker]:
        speakers: list[DiarizedSpeaker] = []
        for speaker_key in speaker_order:
            own = _union_intervals([(start, end) for key, start, end in turns if key == speaker_key])
            other = _union_intervals([(start, end) for key, start, end in turns if key != speaker_key])
            exclusive = _subtract_intervals(own, other)
            selected = exclusive if _interval_duration(exclusive) >= MIN_EXCLUSIVE_EMBEDDING_SECONDS else own
            waveform = _slice_intervals(samples, selected)
            try:
                embedding_input = _pad_embedding_waveform(waveform)
                try:
                    embedding = _normalize_embedding(self._backend.embed(embedding_input))
                finally:
                    if embedding_input is not waveform:
                        embedding_input.fill(0.0)
            finally:
                waveform.fill(0.0)
            if not embedding:
                raise AudioInputError(422, "speaker_embedding_failed", "A speaker embedding could not be computed")
            speakers.append(DiarizedSpeaker(
                speakerKey=speaker_key,
                embedding=embedding,
                voicedSeconds=round(_interval_duration(own), TIME_PRECISION),
            ))
        return speakers


class LocalDiarizationProcessor:
    """Serialize CPU inference and own every decoded-audio cleanup path."""

    def __init__(self, normalizer: FfmpegNormalizer, engine: DeterministicDiarizationEngine, max_duration: float) -> None:
        self._normalizer = normalizer
        self._engine = engine
        self._max_duration = max_duration
        self._lock = threading.Lock()

    def process(self, encoded: bytearray) -> DiarizationResponse:
        """Normalize, validate, infer, and wipe process-owned PCM samples."""
        audio: NormalizedAudio | None = None
        # Decode and inference share one lock. This bounds both FFmpeg stdout
        # memory and native model work to one request per service process.
        with self._lock:
            try:
                audio = self._normalizer.normalize(encoded)
                if audio.duration_seconds > self._max_duration:
                    raise AudioInputError(413, "audio_too_long", "Decoded audio exceeds the duration limit")
                return self._engine.diarize(audio.samples)
            finally:
                if audio is not None:
                    audio.wipe()


def create_local_processor(settings: ServiceSettings) -> LocalDiarizationProcessor:
    """Build the production processor from fixed local model adapters."""
    backend = SherpaBackend(settings)
    engine = DeterministicDiarizationEngine(backend)
    return LocalDiarizationProcessor(FfmpegNormalizer(settings), engine, settings.max_duration_seconds)


def _sanitize_turns(turns: Sequence[RawTurn], duration: float) -> list[RawTurn]:
    sanitized: list[RawTurn] = []
    for turn in turns:
        start = min(duration, max(0.0, float(turn.start)))
        end = min(duration, max(0.0, float(turn.end)))
        if end - start <= 1e-6:
            continue
        sanitized.append(RawTurn(int(turn.speaker), start, end))
    return sorted(sanitized, key=lambda item: (item.start, item.end, item.speaker))


def _key_turns(turns: list[RawTurn]) -> tuple[list[tuple[str, float, float]], list[str]]:
    first_seen: dict[int, tuple[float, int]] = {}
    for turn in turns:
        first_seen.setdefault(turn.speaker, (turn.start, turn.speaker))
    raw_order = sorted(first_seen, key=lambda speaker: first_seen[speaker])
    mapping = {speaker: f"speaker-{index + 1}" for index, speaker in enumerate(raw_order)}
    keyed = [(mapping[turn.speaker], turn.start, turn.end) for turn in turns]
    return keyed, [mapping[speaker] for speaker in raw_order]


def _response_turns(turns: list[tuple[str, float, float]]) -> list[DiarizedTurn]:
    response: list[DiarizedTurn] = []
    for index, (speaker, start, end) in enumerate(turns):
        overlap = any(
            other != speaker and min(end, other_end) - max(start, other_start) > 1e-6
            for other, other_start, other_end in turns
        )
        response.append(DiarizedTurn(
            turnIndex=index,
            speakerKey=speaker,
            startTime=round(start, TIME_PRECISION),
            endTime=round(end, TIME_PRECISION),
            overlap=overlap,
        ))
    return response


def _union_intervals(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    merged: list[list[float]] = []
    for start, end in sorted(intervals):
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return [(start, end) for start, end in merged]


def _subtract_intervals(
    source: list[tuple[float, float]],
    excluded: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    result: list[tuple[float, float]] = []
    for start, end in source:
        fragments = [(start, end)]
        for cut_start, cut_end in excluded:
            next_fragments: list[tuple[float, float]] = []
            for left, right in fragments:
                if cut_end <= left or cut_start >= right:
                    next_fragments.append((left, right))
                    continue
                if cut_start > left:
                    next_fragments.append((left, min(cut_start, right)))
                if cut_end < right:
                    next_fragments.append((max(cut_end, left), right))
            fragments = next_fragments
        result.extend((left, right) for left, right in fragments if right - left > 1e-6)
    return result


def _interval_duration(intervals: list[tuple[float, float]]) -> float:
    return sum(end - start for start, end in intervals)


def _slice_intervals(samples: np.ndarray, intervals: list[tuple[float, float]]) -> np.ndarray:
    chunks: list[np.ndarray] = []
    for start, end in intervals:
        first = max(0, int(round(start * SAMPLE_RATE)))
        last = min(samples.size, int(round(end * SAMPLE_RATE)))
        if last > first:
            chunks.append(samples[first:last])
    if not chunks:
        return np.empty(0, dtype=np.float32)
    return np.ascontiguousarray(np.concatenate(chunks), dtype=np.float32)


def _normalize_embedding(values: Sequence[float]) -> list[float]:
    vector = np.asarray(values, dtype=np.float64)
    if vector.size == 0 or not np.isfinite(vector).all():
        return []
    norm = float(np.linalg.norm(vector))
    if norm <= 1e-12:
        return []
    normalized = vector / norm
    return [round(float(value), EMBEDDING_PRECISION) for value in normalized]


def _pad_embedding_waveform(samples: np.ndarray) -> np.ndarray:
    minimum = int(MIN_EMBEDDING_SECONDS * SAMPLE_RATE)
    if samples.size >= minimum:
        return samples
    padded = np.zeros(minimum, dtype=np.float32)
    padded[:samples.size] = samples
    return padded
