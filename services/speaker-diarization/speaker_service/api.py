"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Added authenticated raw-audio health and diarization endpoints.
2 | maintainer@emeraldcoastsystemsgroup.com   | Rejected concurrent inference before reading request audio so the single native worker never accumulates an unbounded memory queue.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Callable, Protocol

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from .audio import AudioInputError, read_raw_audio, wipe_bytearray
from .engine import create_local_processor
from .transcription import create_transcription_processor
from .logging_config import configure_logging
from .schemas import DiarizationResponse, HealthResponse, TranscriptionResponse
from .settings import MODEL_ID, SAMPLE_RATE, ServiceSettings

configure_logging()
logger = logging.getLogger("speaker-diarization")

ALLOWED_CONTENT_TYPES = {
    "application/octet-stream",
    "audio/aac",
    "audio/flac",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
    "audio/x-wav",
}


class Processor(Protocol):
    """Synchronous local inference boundary run outside the event loop."""

    def process(self, encoded: bytearray) -> DiarizationResponse: ...


class ProcessorProvider:
    """Thread-safe lazy holder so readiness means the pinned models loaded."""

    def __init__(self, factory: Callable[[], Processor], transcriber_factory: Callable[[], object] | None = None) -> None:
        self._factory = factory
        self._transcriber_factory = transcriber_factory or (lambda: None)
        self._processor: Processor | None = None
        self._transcriber: object | None = None
        self._lock = asyncio.Lock()

    async def get(self) -> Processor:
        """Load the CPU models once without blocking the event loop."""
        if self._processor is not None:
            return self._processor
        async with self._lock:
            if self._processor is None:
                self._processor = await asyncio.to_thread(self._factory)
        return self._processor

    async def get_transcriber(self):
        """Load the offline transcription processor on FIRST USE only.

        Kept out of `get()` so readiness — and the resting memory of every
        deployment that only ever diarizes — is unchanged by shipping an ASR model.
        """
        if self._transcriber is not None:
            return self._transcriber
        async with self._lock:
            if self._transcriber is None:
                self._transcriber = await asyncio.to_thread(self._transcriber_factory)
        return self._transcriber


def create_app(
    settings: ServiceSettings | None = None,
    provider: ProcessorProvider | None = None,
    warm_on_start: bool = True,
) -> FastAPI:
    """Create an isolated service instance with injectable deterministic adapters."""
    resolved = settings or ServiceSettings.from_environment()
    processors = provider or ProcessorProvider(
        lambda: create_local_processor(resolved),
        lambda: create_transcription_processor(resolved),
    )

    @asynccontextmanager
    async def lifespan(_application: FastAPI):
        if warm_on_start:
            resolved.validate()
            await processors.get()
        yield

    application = FastAPI(
        title="OSHAL Speaker Diarization",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    _register_routes(application, resolved, processors)
    _register_errors(application)
    return application


def _register_routes(app: FastAPI, settings: ServiceSettings, providers: ProcessorProvider) -> None:
    inference_gate = asyncio.Lock()

    async def authenticate(x_speaker_service_key: str | None = Header(default=None)) -> None:
        expected = settings.service_key.encode("utf-8")
        supplied = (x_speaker_service_key or "").encode("utf-8")
        if not expected or not supplied or not hmac.compare_digest(expected, supplied):
            raise AudioInputError(401, "unauthorized", "A valid speaker service key is required")

    @app.get("/health", response_model=HealthResponse)
    async def health(_: None = _auth_dependency(authenticate)) -> HealthResponse:
        await providers.get()
        return HealthResponse(status="ok", ready=True, modelId=MODEL_ID, sampleRate=SAMPLE_RATE)

    @app.post("/v1/diarize", response_model=DiarizationResponse)
    async def diarize(request: Request, _: None = _auth_dependency(authenticate)) -> DiarizationResponse:
        _validate_content_type(request)
        # Native diarization is deliberately single-worker. Reject instead of
        # letting encoded request bodies and to_thread calls queue in memory.
        if inference_gate.locked():
            raise AudioInputError(429, "service_busy", "Speaker inference is already in progress")
        await inference_gate.acquire()
        started = time.monotonic()
        request_id = _request_id(request)
        encoded: bytearray | None = None
        try:
            encoded = await read_raw_audio(request, settings.max_audio_bytes)
            _safe_log(logging.INFO, "diarization entered", request_id=request_id, audio_bytes=len(encoded))
            processor = await providers.get()
            result = await asyncio.to_thread(processor.process, encoded)
            _safe_log(
                logging.INFO,
                "diarization completed",
                request_id=request_id,
                duration_ms=round((time.monotonic() - started) * 1000),
                turns=len(result.turns),
                speakers=len(result.speakers),
            )
            return result
        finally:
            if encoded is not None:
                wipe_bytearray(encoded)
            inference_gate.release()

    @app.post("/v1/transcribe", response_model=TranscriptionResponse)
    async def transcribe(request: Request, _: None = _auth_dependency(authenticate)) -> TranscriptionResponse:
        """Speaker-labelled transcript of a whole recording, produced on this host.

        Separate from /v1/diarize on purpose: this accepts a long file under its OWN
        budget and holds the inference gate for minutes, where the ambient path is
        bounded to seconds. Same single-worker rule — a second caller is refused
        rather than queued, because two of these would double peak memory.
        """
        _validate_content_type(request)
        if inference_gate.locked():
            raise AudioInputError(429, "service_busy", "Speaker inference is already in progress")
        await inference_gate.acquire()
        started = time.monotonic()
        request_id = _request_id(request)
        encoded: bytearray | None = None
        try:
            encoded = await read_raw_audio(request, settings.max_offline_bytes)
            _safe_log(logging.INFO, "transcription entered", request_id=request_id, audio_bytes=len(encoded))
            processor = await providers.get_transcriber()
            result = await asyncio.to_thread(processor.process, encoded)
            _safe_log(
                logging.INFO,
                "transcription completed",
                request_id=request_id,
                duration_ms=round((time.monotonic() - started) * 1000),
                segments=len(result.segments),
                speakers=result.speakerCount,
            )
            return result
        finally:
            if encoded is not None:
                wipe_bytearray(encoded)
            inference_gate.release()


def _auth_dependency(authenticate):
    from fastapi import Depends

    return Depends(authenticate)


def _register_errors(app: FastAPI) -> None:
    @app.exception_handler(AudioInputError)
    async def audio_error(_request: Request, error: AudioInputError) -> JSONResponse:
        return JSONResponse(status_code=error.status_code, content={"error": error.code, "message": str(error)})

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception) -> JSONResponse:
        _safe_log(
            logging.ERROR,
            "diarization failed",
            exc_info=error,
            request_id=_request_id(request),
            error_type=type(error).__name__,
        )
        return JSONResponse(status_code=500, content={"error": "diarization_unavailable"})


def _validate_content_type(request: Request) -> None:
    raw = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if raw not in ALLOWED_CONTENT_TYPES:
        raise AudioInputError(415, "unsupported_audio_type", "Content-Type must describe raw audio")
    if request.headers.get("content-encoding"):
        raise AudioInputError(415, "content_encoding_not_allowed", "Compressed HTTP bodies are not accepted")


def _request_id(request: Request) -> str:
    candidate = request.headers.get("x-request-id", "")
    if candidate and len(candidate) <= 80 and all(char.isalnum() or char in "-_." for char in candidate):
        return candidate
    return str(uuid.uuid4())


def _safe_log(level: int, message: str, exc_info: Exception | None = None, **fields: object) -> None:
    logger.log(level, message, extra={"safe_fields": fields}, exc_info=exc_info)


app = create_app()
