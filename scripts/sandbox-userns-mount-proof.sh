#!/usr/bin/env sh
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-kernel proof for the ADR-077 sandbox scratch mount: a container uid that owns nothing on the host is denied an unprepared /work, writes a prepared one, and still cannot reach past the per-run directory. Runs as the payload of one disposable container; prints one KEY=VALUE line per fact.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Files are widened (current | FILE_MODE) the way the runner now does it, not set to FILE_MODE, and a seeded 0755 script is part of the tree: prepared_exec proves the foreign uid can still execute it after preparation. A set to 666 made this fact FAILED.
#
# This script is the BODY of the proof, not its driver. It is executed INSIDE a throwaway
# container (`docker run --rm alpine sh -s < scripts/sandbox-userns-mount-proof.sh`), where the
# filesystem is a real Linux one and uid permission checks actually apply — unlike a Windows host,
# where a bind mount is presented through a translation layer and every mode reads 0777.
#
# It models what a userns-remapped daemon does to the dev-console sandbox. Under userns-remap the
# container's root is a host subuid that owns nothing, so the bind-mounted scratch is approached by
# a foreign uid. `nobody` (65534) stands in for that subuid: same kernel check, no daemon
# reconfiguration. A bind mount is resolved by the daemon, so the container reaches the per-run
# directory without traversing its parent — modelled here by putting the per-run directory where
# the foreign uid can reach it, and by testing the root's traversal refusal separately.
#
# Emitted facts (the guard asserts all seven):
#   unprepared_write=denied      a 0700 per-run dir + 0644 seeded file refuses the foreign uid
#   prepared_write=ok            after the shipped modes it writes the seeded file
#   prepared_create=ok           and creates a new file in the same directory
#   prepared_exec=ok             and still executes a seeded 0755 script (files are widened, not set)
#   escape_parent=denied         it still cannot write beside the per-run directory
#   escape_root=denied           it cannot traverse a 0700 scratch root to reach a widened child
#   owner_cleanup=ok             the directory owner can still remove the widened tree
#
# Exits 0 always: the driver reads the facts, not the exit code.

set -u

DIR_MODE=${OSHAL_SCRATCH_DIR_MODE:-777}
FILE_MODE=${OSHAL_SCRATCH_FILE_MODE:-666}
ROOT_MODE=${OSHAL_SCRATCH_ROOT_MODE:-700}

# A real, shell-capable account standing in for the remapped container root. `nobody` is not
# usable for this: its shell is /sbin/nologin, so a refusal would be the shell's, not the kernel's.
FOREIGN=oshalprobe
# 165536 is the first subuid a default `dockremap` userns-remap mapping hands to container root,
# so the foreign uid here is the very uid GitHub Actions' daemon would present at the mount.
FOREIGN_UID=${OSHAL_PROBE_UID:-165536}
if ! id "$FOREIGN" >/dev/null 2>&1; then
  adduser -D -H -s /bin/sh -u "$FOREIGN_UID" "$FOREIGN" >/dev/null 2>&1 || {
    echo "probe_user=FAILED"; exit 0; }
fi
as_foreign() { su "$FOREIGN" -c "$1" >/dev/null 2>&1; }
echo "probe_uid=$(id -u "$FOREIGN")"

base=$(mktemp -d)
chmod 755 "$base"

# --- the mount point, as the runner leaves it before preparation ------------
# `mkdtemp` gives 0700; a seeded worktree file gives 0644, and the seeder copies modes, so a
# tracked 0755 script arrives as one. All are owned by the host user.
work="$base/work"
mkdir "$work"
chmod 700 "$work"
printf 'orig\n' > "$work/seeded.txt"
chmod 644 "$work/seeded.txt"
printf '#!/bin/sh\necho ran\n' > "$work/tool.sh"
chmod 755 "$work/tool.sh"

if as_foreign "echo edited > '$work/seeded.txt'"; then
  echo "unprepared_write=allowed"
else
  echo "unprepared_write=denied"
fi

# --- preparation: exactly what the runner does --------------------------------
# A directory is SET to DIR_MODE; a file is WIDENED by FILE_MODE (current | FILE_MODE), so the
# bits it arrived with — a script's execute bits — survive.
widen_file() { chmod "$(printf '%o' $(( 0$(stat -c %a "$1") | 0$FILE_MODE )))" "$1"; }
chmod "$DIR_MODE" "$work"
widen_file "$work/seeded.txt"
widen_file "$work/tool.sh"

if as_foreign "echo edited > '$work/seeded.txt'"; then
  echo "prepared_write=ok"
else
  echo "prepared_write=FAILED"
fi

if as_foreign "echo new > '$work/created.txt'"; then
  echo "prepared_create=ok"
else
  echo "prepared_create=FAILED"
fi

if as_foreign "'$work/tool.sh'"; then
  echo "prepared_exec=ok"
else
  echo "prepared_exec=FAILED"
fi

# --- containment: the widening stops at the per-run directory ---------------
# Beside the mount (same parent, not widened) the foreign uid is still refused.
if as_foreign "echo escaped > '$base/beside.txt'"; then
  echo "escape_parent=allowed"
else
  echo "escape_parent=denied"
fi

# A scratch ROOT locked to owner-only cannot be traversed to reach a widened child, which is what
# keeps a second host user out of the per-run directory the daemon mounts directly.
root=$(mktemp -d)
mkdir "$root/run"
chmod "$DIR_MODE" "$root/run"
chmod "$ROOT_MODE" "$root"
if as_foreign "echo escaped > '$root/run/x.txt'"; then
  echo "escape_root=allowed"
else
  echo "escape_root=denied"
fi

# --- the owner can still clean up the widened tree --------------------------
if rm -rf "$work" && [ ! -e "$work" ]; then
  echo "owner_cleanup=ok"
else
  echo "owner_cleanup=FAILED"
fi

rm -rf "$base" "$root"
