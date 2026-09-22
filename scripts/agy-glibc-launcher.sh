#!/bin/sh
# Keep the vendor's glibc runtime private to agy. The surrounding OSHAL image remains musl, so
# Node and native addons never see these libraries and cannot accidentally cross libc families.
set -eu

RUNTIME_DIR="${ANTIGRAVITY_GLIBC_RUNTIME_DIR:-/opt/agy-runtime}"
exec "$RUNTIME_DIR/ld-linux.so" \
  --library-path "$RUNTIME_DIR/lib" \
  "$RUNTIME_DIR/agy" "$@"
