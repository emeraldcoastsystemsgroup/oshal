"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Added bounded raw-body collection and pipe-only FFmpeg normalization.
2 | maintainer@emeraldcoastsystemsgroup.com   | Use Starlette's request type directly after removing the incompatible FastAPI wrapper.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass

import numpy as np
from starlette.requests import Request

from .settings import SAMPLE_RATE, ServiceSettings


class AudioInputError(Exception):
    """A sanitized client-facing audio validation error."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


@dataclass
class NormalizedAudio:
    """Mutable normalized samples so callers can wipe them after inference."""

    samples: np.ndarray
    sample_rate: int = SAMPLE_RATE

    @property
    def duration_seconds(self) -> float:
        """Return exact decoded duration from the fixed sample rate."""
        return float(self.samples.size) / float(self.sample_rate)

    def wipe(self) -> None:
        """Best-effort overwrite of the process-owned sample array."""
        self.samples.fill(0.0)


async def read_raw_audio(request: Request, max_bytes: int) -> bytearray:
    """Stream a raw request body into a bounded mutable buffer without spooling."""
    body = bytearray()
    try:
        async for chunk in request.stream():
            if len(body) + len(chunk) > max_bytes:
                raise AudioInputError(413, "audio_too_large", "Audio body exceeds the configured limit")
            body.extend(chunk)
    except Exception:
        wipe_bytearray(body)
        raise
    if not body:
        raise AudioInputError(400, "audio_required", "Request body must contain raw audio bytes")
    return body


def wipe_bytearray(value: bytearray) -> None:
    """Best-effort overwrite of an encoded-audio buffer."""
    value[:] = b"\x00" * len(value)


class FfmpegNormalizer:
    """Decode arbitrary supported audio from stdin into mono float32 PCM stdout."""

    def __init__(
        self,
        settings: ServiceSettings,
        max_duration_seconds: float | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        # The bounds are parameters, not fixed reads of the ambient settings. Offline file
        # transcription decodes a whole recording; the live path stays at its 58-second cap.
        # Defaulting to the ambient values keeps every existing caller byte-identical.
        self._settings = settings
        self._max_duration_seconds = (
            settings.max_duration_seconds if max_duration_seconds is None else max_duration_seconds
        )
        self._timeout_seconds = (
            settings.ffmpeg_timeout_seconds if timeout_seconds is None else timeout_seconds
        )

    @property
    def decode_limit_seconds(self) -> float:
        """The wall ffmpeg is told to stop at — used to DETECT truncation, not just bound it."""
        return self._max_duration_seconds + 1.0

    def normalize(self, encoded: bytearray) -> NormalizedAudio:
        """Normalize without filenames, temporary files, or persistent artifacts."""
        command = _ffmpeg_command(
            self._settings.ffmpeg_binary,
            self._max_duration_seconds,
        )
        try:
            completed = subprocess.run(
                command,
                input=encoded,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self._timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise AudioInputError(422, "audio_decode_failed", "Audio could not be decoded") from error
        return self._to_audio(completed)

    def _to_audio(self, completed: subprocess.CompletedProcess[bytes]) -> NormalizedAudio:
        if completed.returncode != 0 or not completed.stdout:
            raise AudioInputError(422, "audio_decode_failed", "Audio could not be decoded")
        pcm = bytearray(completed.stdout)
        try:
            if len(pcm) % 4 != 0:
                raise AudioInputError(422, "audio_decode_failed", "Decoded audio was malformed")
            samples = np.frombuffer(pcm, dtype="<f4").copy()
        finally:
            wipe_bytearray(pcm)
        if samples.size == 0 or not np.isfinite(samples).all():
            samples.fill(0.0)
            raise AudioInputError(422, "audio_decode_failed", "Decoded audio was empty or invalid")
        return NormalizedAudio(np.ascontiguousarray(samples, dtype=np.float32))


def _ffmpeg_command(binary: str, max_duration_seconds: float) -> list[str]:
    # Decode at most one second beyond the accepted duration. The extra second
    # lets the caller distinguish a valid file exactly at the limit from a
    # longer compressed file without allowing unbounded stdout allocation.
    decode_limit = max_duration_seconds + 1.0
    return [
        binary, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0", "-map_metadata", "-1", "-vn", "-sn", "-dn",
        "-t", f"{decode_limit:.6f}", "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-f", "f32le", "pipe:1",
    ]
