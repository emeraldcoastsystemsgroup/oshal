# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Added a non-root, checksum-pinned, offline speaker inference image.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Added a pinned offline ASR model so a recording can be transcribed without the audio leaving the host. Moonshine, not Whisper: sherpa-onnx pads every Whisper segment to 30s, so transcribing hundreds of short speaker turns would cost a full 30-second forward pass for a two-second turn. Only the int8 weights are copied into the runtime stage; the fp32 copies and the upstream test wavs are dropped.

FROM python:3.11.13-slim-bookworm AS models

ARG SEGMENTATION_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
ARG SEGMENTATION_SHA256="24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"
ARG EMBEDDING_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx"
ARG EMBEDDING_SHA256="c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5"
ARG ASR_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2"
ARG ASR_SHA256="21870cecaa2e44e4e2bf63e02d1072bed183ccd10284871353bd9d24dad14e5e"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl bzip2 \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl --fail --location --retry 4 --output /tmp/segmentation.tar.bz2 "${SEGMENTATION_URL}"; \
    echo "${SEGMENTATION_SHA256}  /tmp/segmentation.tar.bz2" | sha256sum --check --strict; \
    mkdir -p /models/segmentation; \
    tar --extract --bzip2 --file /tmp/segmentation.tar.bz2 --directory /models/segmentation --strip-components=1; \
    test -s /models/segmentation/model.onnx; \
    rm /tmp/segmentation.tar.bz2

RUN set -eux; \
    mkdir -p /models/embedding; \
    curl --fail --location --retry 4 --output /models/embedding/model.onnx "${EMBEDDING_URL}"; \
    echo "${EMBEDDING_SHA256}  /models/embedding/model.onnx" | sha256sum --check --strict

RUN set -eux; \
    curl --fail --location --retry 4 --output /tmp/asr.tar.bz2 "${ASR_URL}"; \
    echo "${ASR_SHA256}  /tmp/asr.tar.bz2" | sha256sum --check --strict; \
    mkdir -p /models/asr; \
    tar --extract --bzip2 --file /tmp/asr.tar.bz2 --directory /models/asr --strip-components=1; \
    rm /tmp/asr.tar.bz2; \
    rm -rf /models/asr/test_wavs; \
    test -s /models/asr/preprocess.onnx; \
    test -s /models/asr/encode.int8.onnx; \
    test -s /models/asr/uncached_decode.int8.onnx; \
    test -s /models/asr/cached_decode.int8.onnx; \
    test -s /models/asr/tokens.txt

FROM python:3.11.13-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    ORT_NUM_THREADS=1 \
    SPEAKER_MODELS_DIR=/models \
    SPEAKER_HOST=0.0.0.0 \
    SPEAKER_PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 speaker \
    && useradd --uid 10001 --gid speaker --no-create-home --shell /usr/sbin/nologin speaker

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY --from=models /models /models
COPY speaker_service ./speaker_service
COPY model-manifest.json LICENSE THIRD_PARTY_NOTICES.md ./

RUN chown -R root:root /app /models \
    && chmod -R a-w /app /models \
    && chmod -R a+rX /app /models

USER 10001:10001

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD python -c "import json,os,urllib.request; r=urllib.request.Request('http://127.0.0.1:8080/health',headers={'X-Speaker-Service-Key':os.environ['SPEAKER_SERVICE_KEY']}); d=json.load(urllib.request.urlopen(r,timeout=8)); assert d['ready'] is True"

CMD ["sh", "-c", "exec uvicorn speaker_service.api:app --host ${SPEAKER_HOST} --port ${SPEAKER_PORT} --workers 1 --no-access-log"]
