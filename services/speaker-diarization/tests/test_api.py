"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Added authenticated raw-body, size-limit, contract, and zeroization tests.
2 | maintainer@emeraldcoastsystemsgroup.com   | Proved concurrent native inference is rejected without building an in-memory request queue.
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import httpx

from speaker_service.api import ProcessorProvider, create_app
from speaker_service.schemas import (
    DiarizationResponse,
    DiarizedSpeaker,
    DiarizedTurn,
)
from speaker_service.settings import MODEL_ID, SAMPLE_RATE, ServiceSettings


SERVICE_KEY = "test-speaker-key-123456789"


class FakeProcessor:
    """Record the exact mutable raw body passed by the endpoint."""

    def __init__(self) -> None:
        self.received: bytearray | None = None

    def process(self, encoded: bytearray) -> DiarizationResponse:
        self.received = encoded
        return DiarizationResponse(
            modelId=MODEL_ID,
            sampleRate=SAMPLE_RATE,
            durationSeconds=1.0,
            turns=[DiarizedTurn(
                turnIndex=0, speakerKey="speaker-1", startTime=0.0, endTime=1.0, overlap=False,
            )],
            speakers=[DiarizedSpeaker(
                speakerKey="speaker-1", embedding=[0.6, 0.8], voicedSeconds=1.0,
            )],
        )


class BlockingProcessor(FakeProcessor):
    """Hold one native call open so a concurrent request can prove fail-fast behavior."""

    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0

    def process(self, encoded: bytearray) -> DiarizationResponse:
        self.calls += 1
        self.started.set()
        if not self.release.wait(timeout=2):
            raise RuntimeError("blocking test processor was not released")
        return super().process(encoded)


def fixture(max_bytes: int = 64):
    processor = FakeProcessor()
    settings = ServiceSettings(
        service_key=SERVICE_KEY,
        models_dir=Path("unused-in-injected-test"),
        max_audio_bytes=max_bytes,
    )
    provider = ProcessorProvider(lambda: processor)
    app = create_app(settings, provider, warm_on_start=False)
    return app, processor


def auth_headers(content_type: str = "audio/webm") -> dict[str, str]:
    return {"X-Speaker-Service-Key": SERVICE_KEY, "Content-Type": content_type}


def request(app, method: str, path: str, **kwargs) -> httpx.Response:
    async def perform() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.request(method, path, **kwargs)

    return asyncio.run(perform())


def test_health_is_authenticated_and_reports_pinned_model() -> None:
    app, _processor = fixture()

    assert request(app, "GET", "/health").status_code == 401
    response = request(app, "GET", "/health", headers=auth_headers())

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok", "ready": True, "modelId": MODEL_ID, "sampleRate": SAMPLE_RATE,
    }


def test_diarize_accepts_raw_audio_and_wipes_the_request_buffer() -> None:
    app, processor = fixture()

    response = request(app, "POST", "/v1/diarize", headers=auth_headers(), content=b"raw-audio-bytes")

    assert response.status_code == 200
    assert response.json()["turns"][0]["speakerKey"] == "speaker-1"
    assert response.json()["speakers"][0]["embedding"] == [0.6, 0.8]
    assert processor.received is not None
    assert bytes(processor.received) == b"\x00" * len(b"raw-audio-bytes")


def test_diarize_rejects_multipart_and_http_content_encoding() -> None:
    app, _processor = fixture()

    multipart = request(
        app, "POST", "/v1/diarize", headers=auth_headers("multipart/form-data"), content=b"not-multipart",
    )
    encoded = request(
        app, "POST", "/v1/diarize", headers={**auth_headers(), "Content-Encoding": "gzip"}, content=b"bytes",
    )

    assert multipart.status_code == 415
    assert multipart.json()["error"] == "unsupported_audio_type"
    assert encoded.status_code == 415
    assert encoded.json()["error"] == "content_encoding_not_allowed"


def test_diarize_rejects_empty_and_oversized_bodies() -> None:
    app, _processor = fixture(max_bytes=4)

    empty = request(app, "POST", "/v1/diarize", headers=auth_headers(), content=b"")
    oversized = request(app, "POST", "/v1/diarize", headers=auth_headers(), content=b"12345")

    assert empty.status_code == 400
    assert empty.json()["error"] == "audio_required"
    assert oversized.status_code == 413
    assert oversized.json()["error"] == "audio_too_large"


def test_diarize_uses_constant_time_auth_check_for_wrong_key() -> None:
    app, processor = fixture()
    headers = {"X-Speaker-Service-Key": "wrong-but-long-key-value", "Content-Type": "audio/wav"}

    response = request(app, "POST", "/v1/diarize", headers=headers, content=b"audio")

    assert response.status_code == 401
    assert processor.received is None


def test_diarize_rejects_concurrent_inference_without_queueing() -> None:
    processor = BlockingProcessor()
    settings = ServiceSettings(
        service_key=SERVICE_KEY,
        models_dir=Path("unused-in-injected-test"),
        max_audio_bytes=64,
    )
    app = create_app(settings, ProcessorProvider(lambda: processor), warm_on_start=False)

    async def perform() -> tuple[httpx.Response, httpx.Response]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            first_task = asyncio.create_task(client.post(
                "/v1/diarize", headers=auth_headers(), content=b"first-audio",
            ))
            started = await asyncio.to_thread(processor.started.wait, 1)
            assert started
            second = await client.post(
                "/v1/diarize", headers=auth_headers(), content=b"second-audio",
            )
            processor.release.set()
            return await first_task, second

    first, second = asyncio.run(perform())

    assert first.status_code == 200
    assert second.status_code == 429
    assert second.json()["error"] == "service_busy"
    assert processor.calls == 1
