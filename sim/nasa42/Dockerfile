# NASA 42 spacecraft simulator — headless, standalone-AC build (ADR-102 §2).
#
# Builds ericstoneking/42 at a pinned commit with:
#   - GUIFLAG empty        -> no OpenGL/GLUT: pure physics, runs headless in CI
#   - _AC_STANDALONE_      -> CFS_FSW spacecraft expose the AcApp IPC socket and 42
#                             BLOCKS on accept until an external controller connects
# The sat-ops case is one CfsSat (4-wheel pyramid, 3 gyros, star tracker) in LEO with the
# star tracker mount zeroed (W1: no mount composition until the W2 EKF). The controller
# socket is 10001 + spacecraft ID.
#
#   docker build -t oshal-sat42:latest sim/nasa42
#   docker run --rm -p 10001:10001 --name oshal-sat42 oshal-sat42:latest

FROM ubuntu:24.04 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential git ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Pin: master as of 2026-07-18 (the commit the TS codec's layouts were transcribed from —
# bump ONLY together with a layout re-verify against Source/AutoCode/ScIPC.c).
ARG FORTYTWO_REF=18106c544b4318e79d393643604356dfa6e7ad78

# NOTE: 42's Makefile is committed with CRLF line endings — the seds must tolerate the \r
# (an anchored `...=$` silently misses), and the greps HARD-FAIL the build if either flag
# didn't take, because a 42 built without _AC_STANDALONE_ free-runs its internal FSW and
# never opens the controller socket (looks like a hang from the adapter's side).
RUN git clone https://github.com/ericstoneking/42.git /opt/42 \
    && cd /opt/42 \
    && git checkout ${FORTYTWO_REF} \
    && sed -i 's/^GUIFLAG *= *-D *_ENABLE_GUI_.*$/GUIFLAG =/' Makefile \
    && sed -i 's/^STANDALONEFLAG *=[ \r]*$/STANDALONEFLAG = -D _AC_STANDALONE_/' Makefile \
    && grep -Eq '^GUIFLAG =[ \r]*$' Makefile \
    && grep -Eq '^STANDALONEFLAG = -D _AC_STANDALONE_' Makefile \
    && make

COPY case /opt/42/sat-ops

EXPOSE 10001
WORKDIR /opt/42
CMD ["./42", "sat-ops"]
