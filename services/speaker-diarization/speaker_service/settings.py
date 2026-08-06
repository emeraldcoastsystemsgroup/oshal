"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Added fail-closed configuration for the isolated speaker service.
2 | maintainer@emeraldcoastsystemsgroup.com   | Added the pinned local ASR model paths and a SEPARATE offline duration/byte budget. The ambient path keeps its deliberate 58-second bound; offline file transcription is a different job with a different risk profile, so it gets its own explicit limit rather than widening the live one.
3 | maintainer@emeraldcoastsystemsgroup.com   | Add an explicit trusted-host allowlist for the isolated HTTP service and reject wildcard, URL-shaped, whitespace, or empty deployment entries.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


MODEL_ID = (
    "sherpa-onnx-1.13.1/pyannote-segmentation-3.0/"
    "3dspeaker-eres2net-en-voxceleb-16k"
)
ASR_MODEL_ID = "sherpa-onnx-1.13.1/moonshine-base-en-int8"
SAMPLE_RATE = 16_000
CPU_THREADS = 1
CLUSTER_THRESHOLD = 0.5
MIN_DURATION_ON = 0.3
MIN_DURATION_OFF = 0.5
DEFAULT_ALLOWED_HOSTS = ("127.0.0.1", "localhost", "speaker-diarization", "testserver")


@dataclass(frozen=True)
class ServiceSettings:
    """Validated runtime settings; inference choices remain compile-time fixed."""

    service_key: str
    models_dir: Path
    ffmpeg_binary: str = "ffmpeg"
    max_audio_bytes: int = 16 * 1024 * 1024
    max_duration_seconds: float = 58.0
    ffmpeg_timeout_seconds: float = 45.0
    # Offline transcription of a whole recording. Deliberately separate from the live
    # ambient bounds above: a two-hour cap here must not loosen the 58-second one there.
    max_offline_duration_seconds: float = 7200.0
    max_offline_bytes: int = 512 * 1024 * 1024
    offline_ffmpeg_timeout_seconds: float = 900.0
    asr_threads: int = 4
    allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS

    @classmethod
    def from_environment(cls) -> "ServiceSettings":
        """Load deployment-only values while keeping model behavior deterministic."""
        return cls(
            service_key=os.getenv("SPEAKER_SERVICE_KEY", "").strip(),
            models_dir=Path(os.getenv("SPEAKER_MODELS_DIR", "/models")),
            ffmpeg_binary=os.getenv("SPEAKER_FFMPEG_BINARY", "ffmpeg").strip() or "ffmpeg",
            max_audio_bytes=_positive_int("SPEAKER_MAX_AUDIO_BYTES", 16 * 1024 * 1024),
            max_duration_seconds=_positive_float("SPEAKER_MAX_DURATION_SECONDS", 58.0),
            ffmpeg_timeout_seconds=_positive_float("SPEAKER_FFMPEG_TIMEOUT_SECONDS", 45.0),
            max_offline_duration_seconds=_positive_float("SPEAKER_MAX_OFFLINE_DURATION_SECONDS", 7200.0),
            max_offline_bytes=_positive_int("SPEAKER_MAX_OFFLINE_BYTES", 512 * 1024 * 1024),
            offline_ffmpeg_timeout_seconds=_positive_float("SPEAKER_OFFLINE_FFMPEG_TIMEOUT_SECONDS", 900.0),
            asr_threads=_positive_int("SPEAKER_ASR_THREADS", 4),
            allowed_hosts=_allowed_hosts(),
        )

    @property
    def segmentation_model(self) -> Path:
        """Return the immutable segmentation model path baked into the image."""
        return self.models_dir / "segmentation" / "model.onnx"

    @property
    def embedding_model(self) -> Path:
        """Return the immutable English speaker-embedding model path."""
        return self.models_dir / "embedding" / "model.onnx"

    @property
    def asr_dir(self):
        """Directory holding the pinned offline ASR model, when the image ships one."""
        return self.models_dir / "asr"

    @property
    def asr_preprocessor(self):
        return self.asr_dir / "preprocess.onnx"

    @property
    def asr_encoder(self):
        return self.asr_dir / "encode.int8.onnx"

    @property
    def asr_uncached_decoder(self):
        return self.asr_dir / "uncached_decode.int8.onnx"

    @property
    def asr_cached_decoder(self):
        return self.asr_dir / "cached_decode.int8.onnx"

    @property
    def asr_tokens(self):
        return self.asr_dir / "tokens.txt"

    @property
    def asr_available(self) -> bool:
        """ASR is OPTIONAL: an image built without the model still diarizes."""
        return all(
            path.is_file()
            for path in (
                self.asr_preprocessor,
                self.asr_encoder,
                self.asr_uncached_decoder,
                self.asr_cached_decoder,
                self.asr_tokens,
            )
        )

    def validate(self) -> None:
        """Fail startup when authentication or pinned model assets are absent."""
        if len(self.service_key) < 16:
            raise RuntimeError("SPEAKER_SERVICE_KEY must contain at least 16 characters")
        missing = [path for path in (self.segmentation_model, self.embedding_model) if not path.is_file()]
        if missing:
            raise RuntimeError(f"Required speaker model is missing: {missing[0]}")


def _positive_int(name: str, fallback: int) -> int:
    value = int(os.getenv(name, str(fallback)))
    if value < 1:
        raise RuntimeError(f"{name} must be positive")
    return value


def _positive_float(name: str, fallback: float) -> float:
    value = float(os.getenv(name, str(fallback)))
    if value <= 0:
        raise RuntimeError(f"{name} must be positive")
    return value


def _allowed_hosts() -> tuple[str, ...]:
    raw = os.getenv("SPEAKER_ALLOWED_HOSTS", ",".join(DEFAULT_ALLOWED_HOSTS))
    hosts = tuple(value.strip().lower() for value in raw.split(",") if value.strip())
    invalid = not hosts or any(
        "*" in host or len(host) > 253 or "://" in host or "/" in host or any(char.isspace() for char in host)
        for host in hosts
    )
    if invalid:
        raise RuntimeError("SPEAKER_ALLOWED_HOSTS must contain explicit comma-separated hostnames without URLs")
    return hosts
