"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Added checksum, dependency, Docker, and no-persistence contract tests.
2 | maintainer@emeraldcoastsystemsgroup.com   | Pinned the optional offline ASR model alongside the two diarization models. This test did its job: adding a third model went red on the exact-set assertion rather than sliding in, which is the whole point of pinning what a private inference image is allowed to contain.
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_model_manifest_contains_exact_pinned_artifacts() -> None:
    manifest = json.loads(read("model-manifest.json"))
    hashes = {model["role"]: model["sha256"] for model in manifest["models"]}

    assert manifest["runtime"]["version"] == "1.13.1"
    assert hashes == {
        "speaker-segmentation": "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
        "speaker-embedding": "c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5",
        # Optional: absent from an image built without it, and /v1/transcribe then 503s.
        "speech-recognition": "21870cecaa2e44e4e2bf63e02d1072bed183ccd10284871353bd9d24dad14e5e",
    }


def test_offline_asr_is_pinned_in_the_dockerfile_too() -> None:
    """The manifest documents; the Dockerfile is what actually gates the download."""
    dockerfile = read("Dockerfile")
    assert "21870cecaa2e44e4e2bf63e02d1072bed183ccd10284871353bd9d24dad14e5e" in dockerfile
    assert "sha256sum --check --strict" in dockerfile
    # Only the int8 weights ship; the fp32 copies and upstream test wavs are dropped.
    assert "rm -rf /models/asr/test_wavs" in dockerfile


def test_runtime_and_docker_are_fixed_to_cpu_single_thread() -> None:
    requirements = read("requirements.txt")
    dockerfile = read("Dockerfile")
    engine = read("speaker_service/engine.py")

    assert "sherpa-onnx==1.13.1" in requirements
    assert "OMP_NUM_THREADS=1" in dockerfile
    assert 'provider="cpu"' in engine
    assert "CPU_THREADS = 1" in read("speaker_service/settings.py")
    assert "sha256sum --check --strict" in dockerfile


def test_service_has_no_durable_audio_or_temp_file_path() -> None:
    source = "\n".join(read(path) for path in [
        "speaker_service/api.py", "speaker_service/audio.py", "speaker_service/engine.py",
    ])

    assert "request.stream()" in source
    assert '"-i", "pipe:0"' in source
    assert '"f32le", "pipe:1"' in source
    for forbidden in ["UploadFile", "File(", "NamedTemporaryFile", "mkstemp", "open(", "redis", "postgres"]:
        assert forbidden not in source
