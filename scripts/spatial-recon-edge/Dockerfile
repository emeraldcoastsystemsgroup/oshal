# spatial-recon-edge — the GPU-box reconstruction service for OSHAL Spaces (ADR-111).
#
# Based on the official nerfstudio image, which already carries CUDA + torch +
# nerfstudio + COLMAP. We add ffmpeg (frame extraction) and our stdlib service.
# The service itself has NO python deps — only the CV toolchain in the base image.
#
# Requires an NVIDIA GPU at runtime:  docker run --gpus all -p 8008:8008 ...
#
# NOTE: bare-metal is often simpler — if your GPU box already runs ComfyUI, it has
# CUDA + python; install nerfstudio + colmap + ffmpeg there and just `python server.py`.
# See README.md.
FROM ghcr.io/nerfstudio-project/nerfstudio:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/spatial-recon-edge
COPY server.py pipeline.py ply_to_splat.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV RECON_HOST=0.0.0.0 \
    RECON_PORT=8008 \
    RECON_WORK_DIR=/data/recon-jobs
EXPOSE 8008

# Cheap liveness probe hitting our /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8008/health',timeout=4).status==200 else 1)"

ENTRYPOINT ["./entrypoint.sh"]
